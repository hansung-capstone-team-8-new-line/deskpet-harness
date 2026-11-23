export class GitHubTransportError extends Error {
    kind;
    proof;
    constructor(kind, message, proof) {
        super(message);
        this.kind = kind;
        this.proof = proof;
    }
}
