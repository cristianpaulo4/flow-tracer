# FlowTracer - API Sequence Visualizer for VS Code & Antigravity IDE

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue.svg)](https://marketplace.visualstudio.com/)

**FlowTracer** é uma extensão poderosa para o VS Code e Antigravity IDE criada para desenvolvedores que precisam de visibilidade total sobre o tráfego HTTP local. Ela intercepta requisições, correlaciona chamadas distribuídas e gera automaticamente **diagramas de sequência interativos** com suporte a zoom amplo, isolamento visual de pares de chamada e exportação instantânea em **cURL**.

---

## ✨ Principais Funcionalidades

- 📊 **Diagramas de Sequência Interativos (Mermaid.js)**: Visualização clara da cadeia ponta a ponta (`Cliente -> Microsserviço Local -> APIs Externas`).
- 🔍 **Inspeção Bidirecional & Foco**:
  - Clique em qualquer chamada no painel lateral ou diretamente no diagrama para isolar visualmente o **Request (Azul Neon)** e a linha tracejada do seu respectivo **Response (Verde para Sucesso, Vermelho para Falha)**.
  - O canvas permanece estável na sua posição e nível de zoom sem movimentos bruscos indesejados.
- 🔎 **Pan & Zoom Amplo**: Navegue suavemente com scroll do mouse e arraste com o botão esquerdo, permitindo ampliações de até **800%**.
- 📋 **Copy as cURL**: Reproduza e depure qualquer requisição externa da cadeia com um clique.
- 🌐 **Compatibilidade Universal de Backend**: Funciona nativamente com **qualquer tecnologia** (Node.js, .NET C#, Python, Rust, Go, Java, PHP, etc.) via proxy HTTP local (`9090`) e propagação padrão **W3C Trace Context (`traceparent`)**.

---

## 🚀 Como Usar

### 1. Iniciar a Captura
Ao abrir o VS Code ou Antigravity IDE, o servidor proxy local do FlowTracer é iniciado automaticamente na porta `9090`.

### 2. Apontar sua Aplicação para o Proxy
Configure as variáveis de ambiente padrão do seu sistema operacional no terminal ou no arquivo `.env` da sua aplicação:

#### Windows (PowerShell):
```powershell
$env:HTTP_PROXY="http://localhost:9090"
$env:HTTPS_PROXY="http://localhost:9090"
```

#### Linux / macOS (Bash / Zsh):
```bash
export HTTP_PROXY="http://localhost:9090"
export HTTPS_PROXY="http://localhost:9090"
```

#### Disparando diretamente via cURL:
```bash
curl -x http://localhost:9090 http://localhost:3000/api/sua-rota
```

### 3. Visualizar o Fluxo
1. Acesse a aba **FlowTracer** na barra de atividades lateral (`Activity Bar`).
2. Clique sobre a requisição raiz interceptada.
3. O painel interativo exibirá o diagrama de sequência completo com toda a cadeia de microsserviços e APIs terceiras consultadas.

---

## ⚙️ Configurações da Extensão

Você pode personalizar o FlowTracer através das configurações do VS Code (`settings.json`):

| Configuração | Padrão | Descrição |
| :--- | :---: | :--- |
| `flowTracer.proxyPort` | `9090` | Porta local utilizada pelo servidor proxy HTTP interceptador. |
| `flowTracer.maxHistory` | `200` | Quantidade máxima de transações completas retidas em memória. |

---

## 📄 Licença

Distribuído sob a licença [MIT](LICENSE).
