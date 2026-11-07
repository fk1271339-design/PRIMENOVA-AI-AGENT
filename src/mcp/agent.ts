import 'dotenv/config';
import Groq from 'groq-sdk';
import { executeCommand } from '../engine/sandbox.js';
import { createOrUpdateFile, readFileContent } from '../engine/fileSystem.js';

// 1. Explicitly load .env file variables

// 2. Validate API Key before Groq Client initialization
const apiKey = process.env.GROQ_API_KEY;
if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_free_groq_api_key_here')) {
  throw new Error(
    "❌ GROQ_API_KEY is missing or empty in .env file!"
  );
}

const groq = new Groq({ apiKey });

const tools: Groq.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'execute_terminal_command',
      description: 'Execute a terminal shell command securely in the sandbox. Returns stdout, stderr, and exitCode.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_or_update_file',
      description: 'Create or update a file with given content. Creates parent directories automatically.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path of the file to create or update.'
          },
          content: {
            type: 'string',
            description: 'The full content of the file.'
          }
        },
        required: ['filePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file_content',
      description: 'Read the contents of a file at the specified path.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path of the file to read.'
          }
        },
        required: ['filePath']
      }
    }
  }
];

export async function runAutonomousAgent(initialPrompt: string, maxIterations: number = 15): Promise<string> {
  const messages: Groq.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are HyperDev Autonomous AI Agent, an expert software engineer and self-healing systems orchestrator.
You have access to tools to execute terminal commands, create/update files, and read files.
When building applications (like Express servers, etc.), ensure you:
1. Initialize package.json if needed.
2. Install required dependencies (e.g. express).
3. Write clean, correct code.
4. Test running the application (e.g. testing starting the server or running unit tests).
5. If any terminal command or test fails, analyze the error output (stderr), fix the code or install missing dependencies, and re-test until success.
Be autonomous, thorough, and self-healing.`
    },
    {
      role: 'user',
      content: initialPrompt
    }
  ];

  let iteration = 0;
  let finalResponse = '';

  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n[Agent Iteration ${iteration}/${maxIterations}] Calling Groq LLM...`);

    try {
      const response = await groq.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.2
      });

      const responseMessage = response.choices[0]?.message;
      if (!responseMessage) {
        console.log('[Agent] No response received from LLM.');
        break;
      }

      messages.push(responseMessage);

      if (responseMessage.content) {
        console.log(`\n[Agent Thought/Message]:\n${responseMessage.content}`);
        finalResponse = responseMessage.content;
      }

      const toolCalls = responseMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        console.log('[Agent] Task completed or finished without further tool calls.');
        break;
      }

      for (const toolCall of toolCalls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse((toolCall.function as any).arguments || '{}');
        console.log(`\n[Tool Call] Executing tool: ${functionName} with args:`, JSON.stringify(functionArgs, null, 2));

        let toolResult = '';
        try {
          if (functionName === 'execute_terminal_command') {
            const res = await executeCommand(functionArgs.command);
            toolResult = JSON.stringify(res);
            console.log(`[Tool Result - execute_terminal_command] ExitCode: ${res.exitCode}`);
            if (res.stdout) console.log(`STDOUT:\n${res.stdout}`);
            if (res.stderr) console.log(`STDERR:\n${res.stderr}`);

            if (res.exitCode !== 0) {
              toolResult += `\n[Self-Healing Notice] Command failed with exit code ${res.exitCode}. Please analyze the error in stderr, fix the code/dependencies using file tools, and re-run.`;
            }
          } else if (functionName === 'create_or_update_file') {
            await createOrUpdateFile(functionArgs.filePath, functionArgs.content);
            toolResult = `Successfully wrote to file ${functionArgs.filePath}`;
            console.log(`[Tool Result - create_or_update_file] ${toolResult}`);
          } else if (functionName === 'read_file_content') {
            const content = await readFileContent(functionArgs.filePath);
            toolResult = content;
            console.log(`[Tool Result - read_file_content] Read ${content.length} characters from ${functionArgs.filePath}`);
          } else {
            toolResult = `Error: Unknown tool ${functionName}`;
          }
        } catch (err: any) {
          toolResult = `Error executing tool ${functionName}: ${err.message}`;
          console.error(`[Tool Error]`, err);
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }
    } catch (apiError: any) {
      console.error(`[Groq API Error]:`, apiError);
      break;
    }
  }

  return finalResponse;
}