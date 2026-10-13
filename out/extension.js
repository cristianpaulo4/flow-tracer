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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const traceManager_1 = require("./core/traceManager");
const proxyServer_1 = require("./core/proxyServer");
const traceTreeDataProvider_1 = require("./providers/traceTreeDataProvider");
const traceWebviewPanel_1 = require("./webview/traceWebviewPanel");
let proxyServer;
async function activate(context) {
    const traceManager = new traceManager_1.TraceManager();
    // 1. Obter porta das configurações do VS Code
    const config = vscode.workspace.getConfiguration('flowTracer');
    const proxyPort = config.get('proxyPort', 9090);
    // 2. Inicializar o Proxy Server Local
    proxyServer = new proxyServer_1.ProxyServer(traceManager, proxyPort);
    try {
        await proxyServer.start();
        vscode.window.showInformationMessage(`FlowTracer: Proxy interceptador ativo em http://localhost:${proxyPort}`);
    }
    catch (err) {
        vscode.window.showErrorMessage(`FlowTracer: Falha ao iniciar proxy na porta ${proxyPort}: ${err.message}`);
    }
    // 3. Registrar o TreeDataProvider da Sidebar
    const treeDataProvider = new traceTreeDataProvider_1.TraceTreeDataProvider(traceManager);
    vscode.window.registerTreeDataProvider('flowTracer.views.transactions', treeDataProvider);
    // 4. Registrar Comandos
    const clearHistoryCmd = vscode.commands.registerCommand('flowTracer.clearHistory', () => {
        traceManager.clearHistory();
        vscode.window.showInformationMessage('FlowTracer: Histórico limpo com sucesso.');
    });
    const toggleCaptureCmd = vscode.commands.registerCommand('flowTracer.toggleCapture', () => {
        const active = traceManager.toggleCapture();
        const status = active ? 'retomada' : 'pausada';
        vscode.window.showInformationMessage(`FlowTracer: Captura de tráfego ${status}.`);
    });
    const openDiagramCmd = vscode.commands.registerCommand('flowTracer.openDiagram', (transaction) => {
        if (!transaction) {
            vscode.window.showWarningMessage('Nenhuma transação selecionada.');
            return;
        }
        traceWebviewPanel_1.TraceWebviewPanel.createOrShow(context.extensionUri, transaction);
    });
    context.subscriptions.push(clearHistoryCmd, toggleCaptureCmd, openDiagramCmd, {
        dispose: () => {
            if (proxyServer) {
                proxyServer.stop();
            }
        }
    });
}
function deactivate() {
    if (proxyServer) {
        proxyServer.stop();
    }
}
//# sourceMappingURL=extension.js.map