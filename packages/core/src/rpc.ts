/** JSON-RPC 2.0 minimal, un message JSON par ligne (stdio). */
export type Handler = (params: any) => unknown | Promise<unknown>;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class RpcServer {
  private handlers = new Map<string, Handler>();
  /** Garde optionnelle : renvoie un message d'erreur pour refuser une méthode (ex. mode lecture seule). */
  private guard: ((method: string) => string | null) | null = null;

  setGuard(g: ((method: string) => string | null) | null) {
    this.guard = g;
  }

  register(method: string, h: Handler) {
    this.handlers.set(method, h);
  }

  /** Traite une ligne ; retourne la réponse sérialisée, ou null pour une notification. */
  async handleLine(line: string): Promise<string | null> {
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } });
    }
    const h = this.handlers.get(req.method);
    try {
      const denied = this.guard?.(req.method);
      if (denied) throw new RpcError(-32003, denied);
      if (!h) throw new RpcError(-32601, `Méthode inconnue : ${req.method}`);
      const result = await h(req.params ?? {});
      return req.id === undefined ? null : JSON.stringify({ jsonrpc: "2.0", id: req.id, result: result ?? null });
    } catch (e) {
      if (req.id === undefined) return null;
      const err = e instanceof RpcError ? e : new RpcError(-32000, e instanceof Error ? e.message : String(e));
      return JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: err.code, message: err.message } });
    }
  }
}
