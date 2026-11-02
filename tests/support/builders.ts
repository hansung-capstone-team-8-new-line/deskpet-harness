import type { CurrentTurnInput, ContextPacket, ExecutionConstraints, HarnessRequest } from '@deskpet/contracts';

/** 테스트용 고정 데이터. G-01 골든 시나리오의 NewLine/DeskPet PR 42 (golden-scenario §4). */
export const REPO = { owner: 'NewLine', name: 'DeskPet' } as const;
export const PR = 42;
export const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
export const BASE_SHA = '0000aaaa1111bbbb2222cccc3333dddd4444eeee';
export const ITEM_ID = '1000006';
export const STAGE_ID = '1000038';
export const T0 = '2026-10-04T10:00:00.000Z';

function route(overall = 0.95, intention = 'pr.review'): CurrentTurnInput['routeDecision'] {
  return {
    headOutputs: { intention: { value: intention, confidence: overall } },
    overallConfidence: overall,
    missingRequiredSlots: [],
    route: 'harness',
    sourceTurnIds: [],
  };
}

export function voiceTurn(
  turnId: string,
  rawText: string,
  opts: { stt?: number | 'unavailable'; routeConfidence?: number; intention?: string; isFinal?: boolean } = {},
): CurrentTurnInput {
  const stt = opts.stt ?? 0.95;
  return {
    conversationId: 'conv-1',
    turnId,
    rawText,
    isFinal: opts.isFinal ?? true,
    inputChannel: 'voice',
    sttConfidenceState: stt === 'unavailable' ? 'unavailable' : 'provided',
    ...(stt === 'unavailable' ? {} : { sttConfidence: stt }),
    routeDecision: route(opts.routeConfidence ?? 0.95, opts.intention),
  };
}

export function webTurn(turnId: string, rawText: string, intention = 'pr.review'): CurrentTurnInput {
  return {
    conversationId: 'conv-1',
    turnId,
    rawText,
    isFinal: true,
    inputChannel: 'web',
    sttConfidenceState: 'not_applicable',
    routeDecision: route(0.95, intention),
  };
}

export function prContext(version = 1): ContextPacket {
  return {
    contextId: 'ctx-1',
    version,
    target: { kind: 'github_pr', repository: { ...REPO }, prNumber: PR },
    candidates: [],
    relatedTurns: [],
    taskRefs: [
      {
        itemId: ITEM_ID,
        stageId: STAGE_ID,
        repository: { ...REPO },
        prNumber: PR,
        source: { kind: 'eureka', ref: `item:${ITEM_ID}` },
      },
    ],
  };
}

export function constraints(deadlineAt = '2026-10-04T10:05:00.000Z'): ExecutionConstraints {
  return { deadlineAt, maxPages: 3, maxResultBytes: 256_000, policyVersion: 'policy-0.1' };
}

export function harnessRequest(requestId: string, turn: CurrentTurnInput, ctx = prContext()): HarnessRequest {
  return { requestId, currentTurn: turn, context: ctx, constraints: constraints() };
}
