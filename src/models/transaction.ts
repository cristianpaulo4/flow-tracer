export interface HttpHeaders {
    [key: string]: string | string[] | undefined;
}

export interface HttpExchange {
    method: string;
    url: string;
    headers: HttpHeaders;
    body?: string;
    timestamp: number;
}

export interface HttpResponseExchange {
    statusCode: number;
    headers: HttpHeaders;
    body?: string;
    durationMs: number;
    timestamp: number;
}

export interface TraceSpan {
    id: string;               // 16 caracteres hexadecimais
    traceId: string;          // 32 caracteres hexadecimais
    parentId?: string;        // ID do span pai (downstream)
    callerService: string;    // Ex: "Client" ou "Service A"
    targetService: string;    // Ex: "Service B"
    request: HttpExchange;
    response?: HttpResponseExchange;
}

export interface TraceTransaction {
    traceId: string;
    rootSpanId: string;
    startTime: number;
    rootMethod: string;
    rootPath: string;
    rootUrl?: string;
    rootHost?: string;
    statusCode?: number;
    durationMs?: number;
    spans: TraceSpan[];
}
