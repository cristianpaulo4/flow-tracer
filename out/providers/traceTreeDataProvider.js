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
exports.TraceTreeDataProvider = exports.EmptyInfoTreeItem = exports.StatusTreeItem = void 0;
const vscode = __importStar(require("vscode"));
const traceTreeItem_1 = require("./traceTreeItem");
class StatusTreeItem extends vscode.TreeItem {
    constructor(status) {
        if (status.isRunning) {
            super(`🟢 In: [${status.inPort}] ➔ Out: [${status.targetPort}]`, vscode.TreeItemCollapsibleState.None);
            this.description = 'Ativo';
            this.tooltip = new vscode.MarkdownString(`### 🟢 FlowTracer Interceptor Ativo\n\n` +
                `- **Porta de Entrada (In):** \`${status.inPort}\` (onde Swagger/Postman chamam)\n` +
                `- **Porta de Destino (Out):** \`${status.targetPort}\` (sua API real)\n\n` +
                `*Clique para reconfigurar as portas In/Out.*`);
            this.iconPath = new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('testing.iconPassed'));
            this.command = {
                command: 'flowTracer.configurePorts',
                title: 'Configurar Portas'
            };
        }
        else {
            super(`🔴 Interceptor Parado`, vscode.TreeItemCollapsibleState.None);
            this.description = `In: [${status.inPort}] ➔ Out: [${status.targetPort}]`;
            this.tooltip = new vscode.MarkdownString(`### 🔴 FlowTracer Interceptor Parado\n\n` +
                `Clique no botão de **Play ▶️** no topo ou aqui para iniciar a interceptação.\n\n` +
                `*Portas configuradas: In [${status.inPort}] ➔ Out [${status.targetPort}]*`);
            this.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('testing.iconFailed'));
            this.command = {
                command: 'flowTracer.startProxy',
                title: 'Iniciar Interceptor'
            };
        }
    }
}
exports.StatusTreeItem = StatusTreeItem;
class EmptyInfoTreeItem extends vscode.TreeItem {
    constructor() {
        super('Aguardando requisições...', vscode.TreeItemCollapsibleState.None);
        this.description = 'faça uma chamada via Swagger/Postman';
        this.iconPath = new vscode.ThemeIcon('info');
    }
}
exports.EmptyInfoTreeItem = EmptyInfoTreeItem;
class TraceTreeDataProvider {
    traceManager;
    getStatus;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(traceManager, getStatus) {
        this.traceManager = traceManager;
        this.getStatus = getStatus;
        this.traceManager.onTransactionsUpdated(() => {
            this._onDidChangeTreeData.fire();
        });
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            const status = this.getStatus();
            const items = [new StatusTreeItem(status)];
            const transactions = this.traceManager.getTransactions();
            if (transactions.length === 0) {
                items.push(new EmptyInfoTreeItem());
            }
            else {
                items.push(...transactions.map((t) => new traceTreeItem_1.TraceTreeItem(t)));
            }
            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }
}
exports.TraceTreeDataProvider = TraceTreeDataProvider;
//# sourceMappingURL=traceTreeDataProvider.js.map