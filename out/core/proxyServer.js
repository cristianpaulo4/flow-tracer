"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyServer = void 0;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const crypto = __importStar(require("crypto"));
class ProxyServer {
    traceManager;
    port;
    server;
    isRunning = false;
    constructor(traceManager, port = 9090) {
        this.traceManager = traceManager;
        this.port = port;
    }
    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((clientReq, clientRes) => this.handleRequest(clientReq, clientRes));
            this.server.listen(this.port, () => {
                this.isRunning = true;
                resolve();
            });
            this.server.on('error', (err) => {
                reject(err);
            });
        });
    }
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
    getPort() {
        return this.port;
    }
    getIsRunning() {
        return this.isRunning;
    }
    handleRequest(clientReq, clientRes) {
        const requestUrl = clientReq.url || '/';
        // 1. Endpoint Interno de Ingestão de Spans
        if (requestUrl === '/__flowtracer/span' && clientReq.method === 'POST') {
            const chunks = [];
            clientReq.on('data', (c) => chunks.push(c));
            clientReq.on('end', () => {
                try {
                    const span = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    this.traceManager.recordSpan(span);
                    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
                    clientRes.end(JSON.stringify({ ok: true }));
                }
                catch (e) {
                    clientRes.writeHead(400, { 'Content-Type': 'application/json' });
                    clientRes.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }
        if (!this.traceManager.isCapturing()) {
            this.forwardDirectly(clientReq, clientRes);
            return;
        }
        const startTime = Date.now();
        // 2. Resolução do Contexto Distribuído (W3C Trace Context)
        const traceparent = clientReq.headers['traceparent'] || '';
        let traceId = '';
        let parentId;
        const w3cRegex = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
        const match = traceparent.match(w3cRegex);
        if (match) {
            traceId = match[1];
            parentId = match[2];
        }
        else {
            traceId = crypto.randomBytes(16).toString('hex');
        }
        const currentSpanId = crypto.randomBytes(8).toString('hex');
        // Mapeamento de Host, Protocolo e Destino
        const hostHeader = clientReq.headers['host'] || 'localhost';
        let isHttps = false;
        let targetPath = requestUrl;
        let targetHostname = hostHeader;
        let targetPort = 80;
        if (requestUrl.startsWith('https://')) {
            isHttps = true;
            try {
                const parsed = new URL(requestUrl);
                targetPath = parsed.pathname + parsed.search;
                targetHostname = parsed.hostname;
                targetPort = parsed.port ? parseInt(parsed.port, 10) : 443;
            }
            catch { }
        }
        else if (requestUrl.startsWith('http://')) {
            try {
                const parsed = new URL(requestUrl);
                targetPath = parsed.pathname + parsed.search;
                targetHostname = parsed.hostname;
                targetPort = parsed.port ? parseInt(parsed.port, 10) : 80;
            }
            catch { }
        }
        else {
            const [hostPart, portPart] = hostHeader.split(':');
            targetHostname = hostPart;
            targetPort = portPart ? parseInt(portPart, 10) : 80;
            if (targetPort === 443) {
                isHttps = true;
            }
        }
        const callerService = parentId ? 'API (localhost:3000)' : 'Client';
        const targetService = targetHostname;
        // 3. Bufferização do Body de Envio
        const reqChunks = [];
        clientReq.on('data', (chunk) => reqChunks.push(chunk));
        clientReq.on('end', () => {
            const reqBody = Buffer.concat(reqChunks).toString('utf-8');
            const span = {
                id: currentSpanId,
                traceId,
                parentId,
                callerService,
                targetService,
                request: {
                    method: clientReq.method || 'GET',
                    url: `${isHttps ? 'https' : 'http'}://${targetHostname}${targetPath}`,
                    headers: { ...clientReq.headers },
                    body: reqBody || undefined,
                    timestamp: startTime
                }
            };
            // Injeta o cabeçalho W3C com o span atual e sanitiza headers para evitar compressão ilegível
            const headersToForward = { ...clientReq.headers };
            headersToForward['traceparent'] = `00-${traceId}-${currentSpanId}-01`;
            headersToForward['host'] = targetHostname;
            delete headersToForward['accept-encoding']; // Solicita resposta em texto plano/json descompactado
            const clientModule = isHttps ? https : http;
            const proxyReq = clientModule.request({
                hostname: targetHostname,
                port: targetPort,
                path: targetPath,
                method: clientReq.method,
                headers: headersToForward,
                timeout: 10000
            }, (proxyRes) => {
                const resChunks = [];
                clientRes.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
                proxyRes.on('data', (chunk) => {
                    resChunks.push(chunk);
                    clientRes.write(chunk);
                });
                proxyRes.on('end', () => {
                    clientRes.end();
                    const durationMs = Date.now() - startTime;
                    const resBody = Buffer.concat(resChunks).toString('utf-8');
                    span.response = {
                        statusCode: proxyRes.statusCode || 500,
                        headers: { ...proxyRes.headers },
                        body: resBody || undefined,
                        durationMs,
                        timestamp: Date.now()
                    };
                    this.traceManager.recordSpan(span);
                });
            });
            proxyReq.on('error', (err) => {
                clientRes.writeHead(502, { 'Content-Type': 'application/json' });
                clientRes.end(JSON.stringify({ error: `Bad Gateway (FlowTracer Proxy): ${err.message}` }));
                span.response = {
                    statusCode: 502,
                    headers: {},
                    body: `Connection Error: ${err.message}`,
                    durationMs: Date.now() - startTime,
                    timestamp: Date.now()
                };
                this.traceManager.recordSpan(span);
            });
            if (reqChunks.length > 0) {
                proxyReq.write(Buffer.concat(reqChunks));
            }
            proxyReq.end();
        });
    }
    forwardDirectly(req, res) {
        const hostHeader = req.headers['host'] || 'localhost';
        const [targetHostname, targetPortStr] = hostHeader.split(':');
        const targetPort = targetPortStr ? parseInt(targetPortStr, 10) : 80;
        const proxyReq = http.request({
            hostname: targetHostname,
            port: targetPort,
            path: req.url,
            method: req.method,
            headers: req.headers
        }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
            res.writeHead(502);
            res.end(`Proxy Error: ${err.message}`);
        });
        req.pipe(proxyReq);
    }
}
exports.ProxyServer = ProxyServer;
//# sourceMappingURL=proxyServer.js.map