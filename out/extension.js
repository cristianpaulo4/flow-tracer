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
let statusBarItem;
let treeDataProvider;
async function activate(context) {
    const traceManager = new traceManager_1.TraceManager();
    // 1. Obter portas e preferências das configurações
    const config = vscode.workspace.getConfiguration('flowTracer');
    let inPort = config.get('inPort') || config.get('proxyPort', 9090);
    let targetPort = config.get('targetPort', 3000);
    const autoStart = config.get('autoStart', true);
    // 2. Inicializar ProxyServer com In / Out
    proxyServer = new proxyServer_1.ProxyServer(traceManager, inPort, targetPort);
    // 3. StatusBarItem Interativo
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'flowTracer.configurePorts';
    context.subscriptions.push(statusBarItem);
    // 4. Registrar TreeDataProvider com função de status
    const getStatus = () => ({
        isRunning: proxyServer ? proxyServer.getIsRunning() : false,
        inPort: proxyServer ? proxyServer.getPort() : inPort,
        targetPort: proxyServer ? proxyServer.getTargetPort() : targetPort
    });
    treeDataProvider = new traceTreeDataProvider_1.TraceTreeDataProvider(traceManager, getStatus);
    vscode.window.registerTreeDataProvider('flowTracer.views.transactions', treeDataProvider);
    const updateUIState = (running) => {
        vscode.commands.executeCommand('setContext', 'flowTracer.proxyRunning', running);
        const currentIn = proxyServer ? proxyServer.getPort() : inPort;
        const currentOut = proxyServer ? proxyServer.getTargetPort() : targetPort;
        if (running) {
            statusBarItem.text = `$(radio-tower) FlowTracer: :${currentIn} ➔ :${currentOut}`;
            statusBarItem.tooltip = `FlowTracer Ativo!\nEntrada: http://localhost:${currentIn}\nDestino: http://localhost:${currentOut}\nClique para configurar portas.`;
            statusBarItem.backgroundColor = undefined;
        }
        else {
            statusBarItem.text = `$(debug-stop) FlowTracer: Parado`;
            statusBarItem.tooltip = `FlowTracer Interceptor Parado.\nClique para configurar portas ou iniciar.`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        statusBarItem.show();
        treeDataProvider.refresh();
    };
    // 5. Funções de Iniciar e Parar
    const startProxy = async () => {
        if (!proxyServer)
            return;
        try {
            const actualPort = await proxyServer.start();
            updateUIState(true);
            if (actualPort !== inPort) {
                vscode.window.showInformationMessage(`FlowTracer: Porta ${inPort} ocupada. Interceptor iniciado em http://localhost:${actualPort} ➔ Destino :${proxyServer.getTargetPort()}`);
            }
            else {
                vscode.window.showInformationMessage(`FlowTracer: Interceptor ativo! In [http://localhost:${actualPort}] ➔ Out [:${proxyServer.getTargetPort()}]`);
            }
        }
        catch (err) {
            updateUIState(false);
            vscode.window.showErrorMessage(`FlowTracer: Falha ao iniciar interceptor: ${err.message}`);
        }
    };
    const stopProxy = async () => {
        if (!proxyServer)
            return;
        await proxyServer.stop();
        updateUIState(false);
        vscode.window.showInformationMessage('FlowTracer: Interceptor parado.');
    };
    // Auto-iniciar se configurado
    if (autoStart) {
        await startProxy();
    }
    else {
        updateUIState(false);
    }
    // 6. Registrar Comandos
    const startProxyCmd = vscode.commands.registerCommand('flowTracer.startProxy', async () => {
        await startProxy();
    });
    const stopProxyCmd = vscode.commands.registerCommand('flowTracer.stopProxy', async () => {
        await stopProxy();
    });
    const configurePortsCmd = vscode.commands.registerCommand('flowTracer.configurePorts', async () => {
        const currentIn = proxyServer ? proxyServer.getPort() : inPort;
        const currentOut = proxyServer ? proxyServer.getTargetPort() : targetPort;
        // Prompt 1: Porta de Entrada
        const inInput = await vscode.window.showInputBox({
            title: 'FlowTracer: Porta de Entrada (In)',
            prompt: 'Digite a porta onde o FlowTracer deve escutar (onde Swagger/Postman chamam)',
            value: currentIn.toString(),
            validateInput: (val) => {
                const num = parseInt(val, 10);
                if (isNaN(num) || num < 1 || num > 65535) {
                    return 'Informe uma porta válida entre 1 e 65535.';
                }
                return null;
            }
        });
        if (!inInput)
            return;
        const newInPort = parseInt(inInput, 10);
        // Prompt 2: Porta de Destino (API)
        const outInput = await vscode.window.showInputBox({
            title: 'FlowTracer: Porta de Destino da API (Out)',
            prompt: 'Digite a porta onde a sua aplicação API realmente roda',
            value: currentOut.toString(),
            validateInput: (val) => {
                const num = parseInt(val, 10);
                if (isNaN(num) || num < 1 || num > 65535) {
                    return 'Informe uma porta válida entre 1 e 65535.';
                }
                if (num === newInPort) {
                    return 'A porta de destino não pode ser igual à porta de entrada!';
                }
                return null;
            }
        });
        if (!outInput)
            return;
        const newTargetPort = parseInt(outInput, 10);
        // Atualizar configurações persistentes
        const wsConfig = vscode.workspace.getConfiguration('flowTracer');
        await wsConfig.update('inPort', newInPort, vscode.ConfigurationTarget.Global);
        await wsConfig.update('proxyPort', newInPort, vscode.ConfigurationTarget.Global);
        await wsConfig.update('targetPort', newTargetPort, vscode.ConfigurationTarget.Global);
        // Se o proxy estava rodando, reiniciar nas novas portas
        const wasRunning = proxyServer ? proxyServer.getIsRunning() : false;
        if (proxyServer) {
            await proxyServer.stop();
            proxyServer.setPorts(newInPort, newTargetPort);
        }
        inPort = newInPort;
        targetPort = newTargetPort;
        if (wasRunning) {
            await startProxy();
        }
        else {
            updateUIState(false);
            vscode.window.showInformationMessage(`FlowTracer: Portas configuradas: In [${newInPort}] ➔ Out [${newTargetPort}]. Clique em Play para iniciar.`);
        }
    });
    const clearHistoryCmd = vscode.commands.registerCommand('flowTracer.clearHistory', () => {
        traceManager.clearHistory();
        vscode.window.showInformationMessage('FlowTracer: Histórico limpo com sucesso.');
    });
    const openDiagramCmd = vscode.commands.registerCommand('flowTracer.openDiagram', (transaction) => {
        if (!transaction) {
            vscode.window.showWarningMessage('Nenhuma transação selecionada.');
            return;
        }
        traceWebviewPanel_1.TraceWebviewPanel.createOrShow(context.extensionUri, transaction);
    });
    context.subscriptions.push(startProxyCmd, stopProxyCmd, configurePortsCmd, clearHistoryCmd, openDiagramCmd, {
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