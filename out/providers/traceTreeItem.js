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
exports.TraceTreeItem = void 0;
const vscode = __importStar(require("vscode"));
class TraceTreeItem extends vscode.TreeItem {
    transaction;
    constructor(transaction) {
        // Exibe a chamada pai completa: ex. "GET http://localhost:3000/api/cep/01001000"
        const displayUrl = transaction.rootUrl || `http://${transaction.rootHost || 'localhost:3000'}${transaction.rootPath}`;
        super(`${transaction.rootMethod} ${displayUrl}`, vscode.TreeItemCollapsibleState.None);
        this.transaction = transaction;
        const status = transaction.statusCode !== undefined ? transaction.statusCode : '...';
        const duration = transaction.durationMs !== undefined ? `${transaction.durationMs}ms` : 'pending';
        // Conta quantas sub-chamadas downstream foram geradas a partir dessa raiz
        const downstreamCount = transaction.spans.filter((s) => !!s.parentId).length;
        const subCallsText = downstreamCount > 0 ? ` (${downstreamCount} downstream)` : '';
        this.description = `[${status}] ${duration}${subCallsText}`;
        this.tooltip = new vscode.MarkdownString(`### ⚡ Chamada Pai: \`${transaction.rootMethod} ${displayUrl}\`\n\n` +
            `- **Status HTTP:** ${status}\n` +
            `- **Latência Total:** ${duration}\n` +
            `- **Trace ID:** \`${transaction.traceId}\`\n` +
            `- **Sub-requisições mapeadas:** ${downstreamCount} chamadas externas\n` +
            `- **Início:** ${new Date(transaction.startTime).toLocaleTimeString()}\n\n` +
            `*Clique para visualizar o diagrama de sequência navegável.*`);
        if (transaction.statusCode === undefined) {
            this.iconPath = new vscode.ThemeIcon('sync~spin');
        }
        else if (transaction.statusCode >= 200 && transaction.statusCode < 300) {
            this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
        }
        else if (transaction.statusCode >= 400 && transaction.statusCode < 500) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
        }
        else {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        }
        this.command = {
            command: 'flowTracer.openDiagram',
            title: 'Abrir Diagrama de Sequência',
            arguments: [transaction]
        };
    }
}
exports.TraceTreeItem = TraceTreeItem;
//# sourceMappingURL=traceTreeItem.js.map