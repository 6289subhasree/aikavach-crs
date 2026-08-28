# How to Use AI KAVACH (Vayu CLI)

This guide explains how to configure and run the Vayu Autonomous Cyber Reasoning System.

## 1. Prerequisites (Ollama)
Vayu requires Ollama to run the AI models locally. Make sure you have Ollama installed and your desired model downloaded.

For example, to use the Llama 3 model:
```bash
ollama pull llama3
```

## 2. Environment Setup
Before running the Vayu CLI, you must activate the Python virtual environment and load the environment variables.

Run these commands in your terminal:
```bash
# 1. Activate the Python environment
source venv/bin/activate

# 2. Load your local environment variables
source .env.local
```

Your `.env.local` file should look like this:
```bash
export AIKAVACH_LLM_PROVIDER=ollama
export AIKAVACH_OLLAMA_URL=http://localhost:11434
export AIKAVACH_OLLAMA_MODEL=llama3  # Or qwen2.5-coder:7b-instruct
```

## 3. Running the Vayu CLI
The main command to run the autonomous reasoning system is:

```bash
python -m crs.vayu <path_to_repository>
```

### Example
To test the system against the provided vulnerable sample:
```bash
python -m crs.vayu samples/vulnerable/command_injection
```

## 4. What Happens When You Run It?
When you execute the command, the Vayu CLI runs completely autonomously through a 4-stage pipeline:

1. **FIND (Static Analysis):** It scans the target repository for vulnerabilities (e.g., Command Injection).
2. **REASON (AI Reasoning):** The local Ollama model analyzes the finding to determine the root cause, security impact, and remediation strategy.
3. **PATCH (AI Generation):** The AI generates a secure code patch that removes the vulnerability while preserving the program's intended structure.
4. **VERIFY (Formal Verification):** The system isolates the code, applies the patch, and runs tests to ensure the application still builds and functions correctly before marking it as `VERIFIED`.
