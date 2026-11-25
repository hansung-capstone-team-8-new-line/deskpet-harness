import { ActionResult as ActionResultSchema, } from '@deskpet/contracts';
import { completeWithRetry } from './llmRetry.js';
const WORKER_STEP_SCHEMA = {
    name: 'deskpet_swarm_worker_step',
    schema: {
        type: 'object',
        properties: {
            kind: {
                type: 'string',
                enum: ['call_tool', 'need_user', 'finish'],
                description: '다음 실행 단계 종류',
            },
            toolName: {
                type: 'string',
                description: "kind가 'call_tool'일 때 호출할 도구 이름",
            },
            mcpId: {
                type: 'string',
                description: "kind가 'call_tool'일 때 대상 MCP ID",
            },
            argumentsJson: {
                type: 'string',
                description: "kind가 'call_tool'일 때 도구 인자 JSON 문자열",
            },
            questionText: {
                type: 'string',
                description: "kind가 'need_user'일 때 사용자에게 물어볼 질문",
            },
            summary: {
                type: 'string',
                description: "kind가 'finish'일 때 필수. 사용자에게 음성으로 전달할 실제 답변·조사 결과·변경 내용을 한국어 1~2문장으로 작성. '작업을 완료했어요.' 같은 무의미한 상투어 금지.",
            },
            displaySummary: {
                type: 'string',
                description: "kind가 'finish'일 때 화면 표시용 결과 요약",
            },
            reasoning: {
                type: 'string',
                description: '이 단계를 선택한 판단 근거',
            },
        },
        required: ['kind', 'reasoning'],
        additionalProperties: false,
    },
};
/**
 * 자율 실행형 Swarm Worker.
 *
 * - 중앙 소유 병목 없이 할당된 목표와 해당 MCP의 Guide를 기반으로 직접 MCP 도구를 호출한다.
 * - Guide에 명시된 가드(`evaluateGuards`) 및 허가 조건(`requiresPermission`) 외의 임의 제한을 두지 않는다.
 * - 사용자 허가나 추가 슬롯 입력이 필요할 때만 PipelinePermissionQueue에 요청을 넣고 응답 수신 시 즉시 재개한다.
 */
export class SwarmWorker {
    d;
    maxSteps;
    constructor(d) {
        this.d = d;
        this.maxSteps = d.maxStepsPerWorker ?? 25;
    }
    async run(input) {
        const workerId = input.workerId ?? this.d.ids.next('wrk');
        const inferredMcpId = input.task.mcpId ?? inferMcpId(input.context, this.d.mcpManager.listServerIds());
        const guide = this.d.guideRegistry.resolve(inferredMcpId);
        const stepBudgetMs = input.stepBudgetMs ?? 120_000;
        const baseDeadlineMs = Date.parse(input.constraints.deadlineAt);
        const stepConstraints = () => {
            const targetMs = Math.max(Number.isFinite(baseDeadlineMs) ? baseDeadlineMs : 0, this.d.clock.nowMs() + stepBudgetMs);
            return {
                deadlineAt: new Date(targetMs).toISOString(),
                ...(input.signal ? { signal: input.signal } : {}),
            };
        };
        let lastActivity = '도구 목록 탐색';
        let lastToolName;
        const reportProgress = (activity, toolName, stepCompleted) => {
            lastActivity = activity;
            if (toolName)
                lastToolName = toolName;
            input.onProgress?.({ activity, ...(toolName ? { toolName } : {}), ...(stepCompleted !== undefined ? { stepCompleted } : {}) });
        };
        const awaitPermission = async (req) => {
            reportProgress('사용자 확인 대기');
            input.onWaitingUser?.(true);
            try {
                return await this.d.permissionQueue.requestPermission(input.requestId, req, input.signal);
            }
            finally {
                input.onWaitingUser?.(false);
                if (!input.signal?.aborted)
                    reportProgress('사용자 응답 수신');
            }
        };
        reportProgress('도구 목록 탐색');
        const mcpTools = await this.discoverTools(stepConstraints());
        const fastPathMap = collectAllFastPaths(this.d.guideRegistry, guide);
        const fastPathDescriptors = Object.values(fastPathMap).map((h) => h.descriptor);
        const workerCtx = {
            requestId: input.requestId,
            conversationId: input.turn.conversationId,
            workerId,
            turn: input.turn,
            context: input.context,
            constraints: input.constraints,
            observations: {},
            ...(input.workingDir ? { workingDir: input.workingDir } : {}),
        };
        const instructions = guide.buildInstructions({
            goal: input.task.goal,
            mcpId: inferredMcpId,
            turn: input.turn,
            context: input.context,
            availableTools: mcpTools,
            fastPathTools: fastPathDescriptors,
            ...(input.wikiExcerpts?.length ? { wikiExcerpts: input.wikiExcerpts } : {}),
            workerId,
            ...(input.workingDir ? { workingDir: input.workingDir } : {}),
        });
        const history = [];
        const recordedCalls = [];
        const actionResults = [];
        const collectedFacts = {};
        const collectedSources = [];
        if (!this.d.llm) {
            return this.buildLlmUnavailableOutcome(workerId, input.task.taskId, inferredMcpId);
        }
        const interruptedOutcome = () => {
            const reason = abortReasonCode(input.signal);
            const isIdleTimeout = reason === 'inactivity_timeout';
            const toolNote = lastToolName ? ` (마지막 도구: ${lastToolName})` : '';
            return this.finalize(guide, {
                workerId,
                taskId: input.task.taskId,
                mcpId: inferredMcpId,
                status: 'failed',
                interrupted: true,
                lastActivity,
                summary: isIdleTimeout
                    ? `진행 상황이 없어 '${input.task.goal}' 작업을 중단했어요${toolNote}.`
                    : `요청이 취소되어 '${input.task.goal}' 작업을 중단했어요${toolNote}.`,
                toolCalls: recordedCalls,
                error: reason,
            }, actionResults, collectedFacts, collectedSources);
        };
        for (let step = 0; step < this.maxSteps; step++) {
            if (input.signal?.aborted)
                return interruptedOutcome();
            const callConstraints = stepConstraints();
            reportProgress(`단계 ${step + 1} 계획 중`);
            let decision;
            try {
                decision = await this.planNextStep(instructions, input, history, workerCtx.observations, callConstraints);
            }
            catch (e) {
                if (input.signal?.aborted)
                    return interruptedOutcome();
                return this.finalize(guide, {
                    workerId,
                    taskId: input.task.taskId,
                    mcpId: inferredMcpId,
                    status: 'failed',
                    lastActivity,
                    summary: '작업을 계획하는 중 오류가 발생했어요.',
                    toolCalls: recordedCalls,
                    error: e instanceof Error ? e.message : String(e),
                }, actionResults, collectedFacts, collectedSources);
            }
            if (input.signal?.aborted)
                return interruptedOutcome();
            reportProgress(`단계 ${step + 1} 결정 (${decision.kind})`, decision.toolName);
            if (decision.kind === 'finish') {
                const summary = resolveFinishSummary(decision);
                const displaySummary = decision.displaySummary?.trim();
                return this.finalize(guide, {
                    workerId,
                    taskId: input.task.taskId,
                    mcpId: inferredMcpId,
                    status: 'completed',
                    summary,
                    ...(displaySummary && !isGenericCompletionSummary(displaySummary) ? { displaySummary } : {}),
                    toolCalls: recordedCalls,
                    data: collectedFacts,
                }, actionResults, collectedFacts, collectedSources);
            }
            if (decision.kind === 'need_user') {
                const questionText = decision.questionText?.trim() || '진행을 위해 필요한 정보를 조금 더 알려주시겠어요?';
                const res = await awaitPermission({
                    workerId,
                    mcpId: inferredMcpId,
                    toolName: 'worker_clarification',
                    spec: {
                        kind: 'clarification',
                        purpose: 'worker_clarification',
                        questionText,
                    },
                });
                if (input.signal?.aborted)
                    return interruptedOutcome();
                history.push({ step, action: 'need_user', question: questionText, resolution: res });
                if (res.updatedContext) {
                    input.context = res.updatedContext;
                    workerCtx.context = res.updatedContext;
                }
                if (res.updatedTurn) {
                    input.turn = res.updatedTurn;
                    workerCtx.turn = res.updatedTurn;
                }
                if (res.verdict === 'revoked' || res.verdict === 'expired') {
                    return this.finalize(guide, {
                        workerId,
                        taskId: input.task.taskId,
                        mcpId: inferredMcpId,
                        status: 'failed',
                        summary: '사용자 응답을 받지 못해 작업을 종료했어요.',
                        toolCalls: recordedCalls,
                        error: res.rationale,
                    }, actionResults, collectedFacts, collectedSources);
                }
                continue;
            }
            // ---- call_tool
            const targetMcpId = decision.mcpId?.trim() || inferredMcpId;
            const toolName = decision.toolName?.trim() || '';
            if (!toolName) {
                history.push({ step, error: 'toolName is empty' });
                continue;
            }
            const parsedArgs = parseJsonArgs(decision.argumentsJson);
            const ownerGuide = !decision.mcpId ? guideForFastPath(this.d.guideRegistry, toolName) : undefined;
            const activeGuide = ownerGuide ?? (targetMcpId === inferredMcpId ? guide : this.d.guideRegistry.resolve(targetMcpId));
            const effectiveMcpId = ownerGuide ? ownerGuide.mcpId : targetMcpId;
            const plannedCall = { mcpId: effectiveMcpId, toolName, arguments: parsedArgs };
            // Guide에 명시된 guard만 검사 (미구현 시 무조건 통과)
            if (activeGuide.evaluateGuards) {
                const guard = activeGuide.evaluateGuards({
                    mcpId: effectiveMcpId,
                    goal: input.task.goal,
                    turn: input.turn,
                    context: input.context,
                    constraints: input.constraints,
                    plannedCall,
                    observations: workerCtx.observations,
                });
                if (!guard.allowed) {
                    if (guard.clarifyPrompt) {
                        const clarifyRes = await awaitPermission({
                            workerId,
                            mcpId: targetMcpId,
                            toolName,
                            spec: {
                                kind: 'clarification',
                                purpose: guard.clarifyPurpose ?? 'guide_guard_clarification',
                                ...(guard.clarifySlots ? { requiredSlots: guard.clarifySlots } : {}),
                                questionText: guard.clarifyPrompt,
                            },
                        });
                        if (input.signal?.aborted)
                            return interruptedOutcome();
                        history.push({ step, guardBlocked: guard.reasons, userFollowUp: clarifyRes });
                        if (clarifyRes.verdict === 'revoked' || clarifyRes.verdict === 'expired') {
                            return this.finalize(activeGuide, {
                                workerId,
                                taskId: input.task.taskId,
                                mcpId: targetMcpId,
                                status: 'blocked',
                                summary: guard.clarifyPrompt,
                                toolCalls: recordedCalls,
                                blockedReasons: guard.reasons,
                            }, actionResults, collectedFacts, collectedSources);
                        }
                        continue;
                    }
                    return this.finalize(activeGuide, {
                        workerId,
                        taskId: input.task.taskId,
                        mcpId: targetMcpId,
                        status: 'blocked',
                        summary: `Guide 조건으로 차단되었습니다: ${guard.reasons.join(', ')}`,
                        toolCalls: recordedCalls,
                        blockedReasons: guard.reasons,
                    }, actionResults, collectedFacts, collectedSources);
                }
            }
            // Guide가 명시적으로 사용자 허가를 요구할 때만 PipelinePermissionQueue 사용
            const permSpec = activeGuide.requiresPermission?.(plannedCall, workerCtx) ?? null;
            if (permSpec) {
                const permRes = await awaitPermission({
                    workerId,
                    mcpId: effectiveMcpId,
                    toolName,
                    spec: {
                        ...permSpec,
                        facts: { ...collectedFacts, ...(permSpec.facts ?? {}) },
                    },
                });
                if (input.signal?.aborted)
                    return interruptedOutcome();
                if (permSpec.kind === 'clarification') {
                    history.push({ step, clarification: permSpec.questionText, resolution: permRes });
                    if (permRes.updatedContext) {
                        input.context = permRes.updatedContext;
                        workerCtx.context = permRes.updatedContext;
                    }
                    if (permRes.updatedTurn) {
                        input.turn = permRes.updatedTurn;
                        workerCtx.turn = permRes.updatedTurn;
                    }
                    if (permRes.verdict === 'revoked' || permRes.verdict === 'expired') {
                        return this.finalize(activeGuide, {
                            workerId,
                            taskId: input.task.taskId,
                            mcpId: targetMcpId,
                            status: 'failed',
                            summary: '필요한 정보가 확인되지 않아 작업을 중단했어요.',
                            toolCalls: recordedCalls,
                            error: permRes.rationale,
                        }, actionResults, collectedFacts, collectedSources);
                    }
                    continue;
                }
                if (!permRes.approved) {
                    history.push({ step, tool: toolName, permissionDenied: permRes.verdict, reason: permRes.rationale });
                    if (permRes.verdict === 'rejected') {
                        if (permSpec.scope) {
                            collectedFacts['declined'] = { action: permSpec.scope.action, target: permSpec.scope.target };
                            collectedFacts['noExternalChanges'] = true;
                        }
                        return this.finalize(activeGuide, {
                            workerId,
                            taskId: input.task.taskId,
                            mcpId: effectiveMcpId,
                            status: 'completed',
                            summary: '요청하신 작업을 실행하지 않고 취소했어요.',
                            toolCalls: recordedCalls,
                        }, actionResults, collectedFacts, collectedSources);
                    }
                    continue;
                }
            }
            // ---- 직접 실행 (Fast-Path 어댑터 우선 매칭, 없으면 McpClientManager.callTool 직접 실행)
            const fastPath = activeGuide.fastPathAdapters?.[toolName] ?? fastPathMap[toolName];
            reportProgress(`도구 실행 중 (${toolName})`, toolName);
            let callRes;
            let providedActions;
            let followUpPending;
            try {
                if (fastPath) {
                    const fpOut = await fastPath.execute(parsedArgs, workerCtx, callConstraints);
                    callRes = fpOut.result;
                    if (fpOut.facts)
                        Object.assign(collectedFacts, fpOut.facts);
                    if (fpOut.sources?.length)
                        collectedSources.push(...fpOut.sources);
                    if (fpOut.actionResults !== undefined)
                        providedActions = fpOut.actionResults;
                    if (fpOut.pending)
                        followUpPending = fpOut.pending;
                }
                else {
                    callRes = await this.d.mcpManager.callTool({ mcpId: targetMcpId, toolName, arguments: parsedArgs, deadlineAt: callConstraints.deadlineAt }, callConstraints);
                    collectedSources.push({
                        kind: 'mcp',
                        ref: `${targetMcpId}::${toolName}`,
                        observedAt: callRes.observedAt,
                    });
                }
            }
            catch (e) {
                if (input.signal?.aborted)
                    return interruptedOutcome();
                throw e;
            }
            if (input.signal?.aborted)
                return interruptedOutcome();
            reportProgress(`도구 실행 완료 (${toolName})`, toolName, step + 1);
            recordedCalls.push({
                toolName,
                arguments: parsedArgs,
                ok: callRes.ok,
                ...(callRes.usedFastPath ? { usedFastPath: true } : {}),
                summary: summarizeCallResult(callRes, 500),
            });
            if (providedActions) {
                actionResults.push(...providedActions);
            }
            else {
                const ar = toMcpActionResult(this.d.ids.next('op'), effectiveMcpId, toolName, callRes, this.d.clock.nowIso());
                if (ar)
                    actionResults.push(ar);
            }
            if (followUpPending) {
                const out = this.finalize(activeGuide, {
                    workerId,
                    taskId: input.task.taskId,
                    mcpId: effectiveMcpId,
                    status: 'completed',
                    summary: summarizeCallResult(callRes, 180) || '후속 확인이 필요해요.',
                    toolCalls: recordedCalls,
                    data: collectedFacts,
                }, actionResults, collectedFacts, collectedSources);
                return { ...out, pending: followUpPending };
            }
            const fullObservation = summarizeCallResult(callRes, 6_000);
            workerCtx.observations['lastToolResult'] = {
                step,
                mcpId: effectiveMcpId,
                toolName,
                ok: callRes.ok,
                output: callRes.structuredContent ?? fullObservation,
                ...(callRes.error ? { error: callRes.error } : {}),
            };
            history.push({
                step,
                toolName,
                mcpId: effectiveMcpId,
                arguments: parsedArgs,
                ok: callRes.ok,
                ...(callRes.usedFastPath ? { usedFastPath: true } : {}),
                output: summarizeCallResult(callRes, 500),
                ...(callRes.error ? { error: callRes.error } : {}),
            });
        }
        return this.finalize(guide, {
            workerId,
            taskId: input.task.taskId,
            mcpId: inferredMcpId,
            status: 'failed',
            summary: `최대 실행 단계(${this.maxSteps})에 도달해 작업을 종료했어요.`,
            toolCalls: recordedCalls,
            error: 'max_worker_steps_reached',
        }, actionResults, collectedFacts, collectedSources);
    }
    /** 연결된 모든 MCP 서버의 도구를 제한 없이 탐색해 Worker가 자유롭게 조합·호출할 수 있게 한다 */
    async discoverTools(c) {
        try {
            return await this.d.mcpManager.listTools(undefined, c);
        }
        catch {
            return [];
        }
    }
    async planNextStep(instructions, input, history, observations, c) {
        const res = await completeWithRetry(this.d.llm, {
            purpose: 'guide',
            instructions,
            input: JSON.stringify({
                goal: input.task.goal,
                task: {
                    taskId: input.task.taskId,
                    ...(input.task.mcpId ? { mcpId: input.task.mcpId } : {}),
                    goal: input.task.goal,
                },
                hints: input.task.hints ?? null,
                userText: input.turn.rawText,
                activeTarget: input.context.target ?? null,
                taskRefs: input.context.taskRefs,
                recentTurns: input.context.relatedTurns.slice(-4),
                dependencyResults: input.dependencyResults ?? null,
                observations,
                executionHistory: history,
            }),
            jsonSchema: WORKER_STEP_SCHEMA,
            maxOutputTokens: 1024,
            deadlineAt: c.deadlineAt,
            ...(c.signal ? { signal: c.signal } : {}),
        }, { now: () => this.d.clock.nowMs() });
        const raw = (res.json ?? JSON.parse(res.text));
        const kind = raw['kind'];
        if (kind !== 'call_tool' && kind !== 'need_user' && kind !== 'finish') {
            throw new Error(`invalid worker step kind: ${String(kind)}`);
        }
        return {
            kind,
            ...(typeof raw['toolName'] === 'string' ? { toolName: raw['toolName'] } : {}),
            ...(typeof raw['mcpId'] === 'string' ? { mcpId: raw['mcpId'] } : {}),
            ...(typeof raw['argumentsJson'] === 'string' ? { argumentsJson: raw['argumentsJson'] } : {}),
            ...(typeof raw['questionText'] === 'string' ? { questionText: raw['questionText'] } : {}),
            ...(typeof raw['summary'] === 'string' ? { summary: raw['summary'] } : {}),
            ...(typeof raw['displaySummary'] === 'string' ? { displaySummary: raw['displaySummary'] } : {}),
            reasoning: typeof raw['reasoning'] === 'string' ? raw['reasoning'] : '',
        };
    }
    finalize(guide, summary, actionResults, facts, sources) {
        const formatted = guide.formatOutcome?.(summary);
        if (formatted) {
            summary.summary = formatted.summary;
            if (formatted.facts)
                Object.assign(facts, formatted.facts);
            if (formatted.sources?.length)
                sources.push(...formatted.sources);
        }
        return { summary, actionResults, facts, sources };
    }
    buildLlmUnavailableOutcome(workerId, taskId, mcpId) {
        return {
            summary: {
                workerId,
                taskId,
                mcpId,
                status: 'failed',
                summary: '추론 모델(LLM)이 설정되지 않아 자율 MCP 작업을 실행할 수 없어요.',
                toolCalls: [],
                error: 'llm_not_configured',
            },
            actionResults: [],
            facts: {},
            sources: [],
        };
    }
}
function abortReasonCode(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error && reason.message === 'inactivity_timeout')
        return 'inactivity_timeout';
    if (typeof reason === 'string' && reason === 'inactivity_timeout')
        return 'inactivity_timeout';
    return 'aborted';
}
function collectAllFastPaths(registry, preferredGuide) {
    const merged = {};
    for (const g of registry.list()) {
        if (g.fastPathAdapters) {
            for (const [name, handler] of Object.entries(g.fastPathAdapters)) {
                if (!merged[name])
                    merged[name] = handler;
            }
        }
    }
    if (preferredGuide.fastPathAdapters) {
        for (const [name, handler] of Object.entries(preferredGuide.fastPathAdapters)) {
            merged[name] = handler;
        }
    }
    return merged;
}
function guideForFastPath(registry, toolName) {
    return registry.list().find((g) => Boolean(g.fastPathAdapters?.[toolName]));
}
function inferMcpId(context, registeredIds) {
    if (context.target?.kind === 'mcp_tool')
        return context.target.mcpId;
    if (context.target?.kind === 'github_pr')
        return 'github';
    if (registeredIds.length === 1)
        return registeredIds[0];
    return '*';
}
function parseJsonArgs(raw) {
    if (!raw?.trim())
        return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function isGenericCompletionSummary(text) {
    const trimmed = text?.trim() ?? '';
    if (!trimmed)
        return true;
    return /^(작업을\s*)?(모두\s*)?완료(했어요|했습니다|됨|되었습니다)[.!~ ]*$/.test(trimmed);
}
function resolveFinishSummary(decision) {
    const summary = decision.summary?.trim();
    if (summary && !isGenericCompletionSummary(summary))
        return summary;
    const displaySummary = decision.displaySummary?.trim();
    if (displaySummary && !isGenericCompletionSummary(displaySummary))
        return displaySummary;
    const reasoning = decision.reasoning.trim();
    if (reasoning && !isGenericCompletionSummary(reasoning))
        return reasoning;
    return summary || '작업을 완료했어요.';
}
function summarizeCallResult(r, maxChars = 600) {
    if (r.error)
        return r.error.slice(0, maxChars);
    const texts = r.content.map((b) => b.text).filter((t) => Boolean(t));
    if (texts.length)
        return texts.join('\n').slice(0, maxChars);
    if (r.structuredContent)
        return JSON.stringify(r.structuredContent).slice(0, maxChars);
    return r.ok ? 'ok' : 'error';
}
function toMcpActionResult(operationId, mcpId, toolName, res, observedAt) {
    const candidate = ActionResultSchema.safeParse({
        operationId,
        action: 'mcp_tool_call',
        target: { kind: 'mcp_tool', mcpId, toolName },
        status: res.ok ? 'succeeded' : 'failed',
        dispatchState: 'sent',
        facts: res.structuredContent ?? { summary: summarizeCallResult(res) },
        externalRefs: [{ system: 'mcp', kind: 'tool_call', id: `${mcpId}::${toolName}` }],
        observedAt,
    });
    return candidate.success ? candidate.data : undefined;
}
