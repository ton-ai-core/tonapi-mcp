#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TonApiCliWrapper } from './ton-api-cli-wrapper.js';
import dotenv from 'dotenv';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';

// Load environment variables from .env file if present
dotenv.config();

// Parse command line arguments
const args = process.argv.slice(2);
let apiKey = '';
let isTestnet = false;
let moduleFilter: string[] = [];

// Process command line arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--api-key' && i + 1 < args.length) {
    apiKey = args[i + 1];
    i++;
  } else if (args[i] === '--testnet' || args[i] === '-t') {
    isTestnet = true;
  } else if (args[i] === '--modules' && i + 1 < args.length) {
    // Parse module filter as a comma-separated list
    moduleFilter = args[i + 1].split(',').map(m => m.trim());
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Usage: ton-api-mcp-server [options]

Options:
  --api-key <key>       TON API key (can also be set via TON_API_KEY env variable)
  --testnet, -t         Use testnet instead of mainnet
  --modules <list>      Comma-separated list of API modules to include (e.g., "blockchain,accounts")
  --help, -h            Show this help message
`);
    process.exit(0);
  }
}

// Initialize the TON API client
const wrapper = new TonApiCliWrapper({
  testnet: isTestnet,
  apiKey: apiKey,
  skipApiKeyCheck: true,  // We'll check for API key later
  moduleFilter: moduleFilter.length > 0 ? moduleFilter : undefined
});

// Module descriptions for TON API modules, based on documentation and SDK analysis
const MODULE_DESCRIPTIONS: Record<string, string> = {
  accounts: 'Operations with TON accounts, get balances, wallet information, and transaction history',
  blockchain: 'Access to blockchain data, blocks, transactions, masterchain, and validators. This is the core module that powers TON Viewer and provides detailed blockchain information',
  connect: 'Functionality for connecting and authorizing in dApps through TON Connect',
  dns: 'Working with DNS records and domains in TON',
  emulation: 'Emulation of smart contract execution and transactions without actually executing them',
  events: 'Working with blockchain events and subscriptions to them',
  extracurrency: 'Operations with additional currencies (tokens) in TON',
  gasless: 'Tools for sending transactions without the sender paying gas (gas sponsoring)',
  inscriptions: 'Working with inscription tokens in TON',
  jettons: 'Operations with Jetton tokens (similar to ERC-20 in TON)',
  liteserver: 'Low-level access to data via Lite Server Protocol',
  multisig: 'Working with multi-signature wallets',
  nft: 'Operations with NFT collections and tokens',
  rates: 'Getting exchange rates for TON and tokens',
  staking: 'Staking operations and operations with nominators',
  storage: 'Working with TON Storage, uploading and downloading files',
  traces: 'Transaction trace analysis and tracking',
  utilities: 'Helper functions for working with TON',
  wallet: 'Managing wallets and transactions'
};

// Function to get module description
function getModuleDescription(moduleName: string): string {
  // Convert module name to match the keys in MODULE_DESCRIPTIONS
  // e.g., extraCurrency instead of extra_currency
  const normalizedName = moduleName.toLowerCase();
  return MODULE_DESCRIPTIONS[normalizedName] || `Module ${moduleName}`;
}

// Schemas for MCP tool parameters
const CallMethodArgsSchema = z.object({
  module: z.string().describe('Name of the TON API module'),
  method: z.string().describe('Name of the method to call'),
  params: z.record(z.unknown()).optional().describe('Parameters to pass to the method (JSON object)'),
  args: z.array(z.unknown()).optional().describe('Additional arguments (array)'),
  network: z.enum(['mainnet', 'testnet']).optional().describe('Network to use (mainnet or testnet)')
});

const ListModulesArgsSchema = z.object({
  network: z.enum(['mainnet', 'testnet']).optional().describe('Network to use (mainnet or testnet)')
});

const ListMethodsArgsSchema = z.object({
  module: z.string().describe('Name of the TON API module to list methods for'),
  network: z.enum(['mainnet', 'testnet']).optional().describe('Network to use (mainnet or testnet)')
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Server setup
const server = new Server(
  {
    name: "ton-api-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Register list_tools handler
server.setRequestHandler(ListToolsRequestSchema, () => {
  return {
    tools: [
      {
        name: "call_method",
        description: 
          "Call a TON API method from any available module. " +
          "You must specify the module name and method name. " +
          "You can provide parameters as a JSON object in 'params' or as individual arguments in 'args' array.",
        inputSchema: zodToJsonSchema(CallMethodArgsSchema) as ToolInput,
      },
      {
        name: "list_modules",
        description: 
          "List all available TON API modules. " +
          "Use this to discover what functionality is available through the API.",
        inputSchema: zodToJsonSchema(ListModulesArgsSchema) as ToolInput,
      },
      {
        name: "list_methods",
        description: 
          "List all methods available in a specific TON API module. " +
          "You must specify the module name.",
        inputSchema: zodToJsonSchema(ListMethodsArgsSchema) as ToolInput,
      },
    ],
  };
});

// Register call_tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    
    switch (name) {
      case "call_method": {
        try {
          const parsed = CallMethodArgsSchema.safeParse(args);
          if (!parsed.success) {
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify({
                  error: true,
                  message: `Invalid arguments for call_method: ${parsed.error}`
                })
              }],
              isError: true,
            };
          }
          
          const { module, method, params, args: methodArgs = [], network } = parsed.data;
          
          // Более подробная отладка сети
          console.error(chalk.cyan(`Raw parsed arguments: ${JSON.stringify(args)}`));
          console.error(chalk.cyan(`Parsed network parameter: ${network} (${typeof network})`));
          
          // Check if we have an API key
          const effectiveApiKey = apiKey || process.env.TON_API_KEY;
          if (!effectiveApiKey) {
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify({
                  error: true,
                  message: 'API key not specified. Please set the TON_API_KEY environment variable or provide --api-key argument.'
                })
              }],
              isError: true,
            };
          }
          
          // Determine which network to use - from request or from server settings
          console.error(chalk.blue(`Network from request: ${network}, Server testnet flag: ${isTestnet}`));
          
          // Принудительно проверяем и логируем информацию о сети
          let useTestnet: boolean;
          if (network !== undefined) {
            // Если сеть указана в запросе, используем её
            console.error(chalk.yellow(`Using network from request: ${network}`));
            useTestnet = network === 'testnet';
          } else {
            // Иначе используем значение из флага командной строки
            console.error(chalk.yellow(`Network not specified in request, using server setting: ${isTestnet ? 'testnet' : 'mainnet'}`));
            useTestnet = isTestnet;
          }
          
          console.error(chalk.blue(`Final network decision: ${useTestnet ? 'testnet' : 'mainnet'}`));
          
          // Create a new wrapper with the API key for the actual request and specified network
          const requestWrapper = new TonApiCliWrapper({
            testnet: useTestnet,
            apiKey: effectiveApiKey,
            moduleFilter: moduleFilter.length > 0 ? moduleFilter : undefined
          });
          
          // Перенаправляем все отладочные сообщения в stderr, а не stdout
          console.error(chalk.yellow(`Calling ${module}.${method} on network ${useTestnet ? 'testnet' : 'mainnet'} with arguments:`), JSON.stringify(params));
          
          // Check if module and method exist
          if (!requestWrapper.hasMethod(module, method)) {
            const errorMessage = `Method ${method} not found in module ${module}`;
            console.error(chalk.red(errorMessage));
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify({
                  error: true,
                  message: errorMessage
                })
              }],
              isError: true,
            };
          }
          
          // Prepare arguments for the method call
          const callArgs: unknown[] = [];
          if (params) {
            callArgs.push(params);
          }
          if (methodArgs && methodArgs.length > 0) {
            callArgs.push(...methodArgs);
          }
          
          // Call the method
          try {
            // Универсальная функция-обработчик для методов, требующих accountId
            const accountIdMethods = [
              { module: "blockchain", method: "getBlockchainRawAccount" },
              { module: "blockchain", method: "getBlockchainAccountTransactions" },
              { module: "blockchain", method: "getBlockchainAccountInspect" },
              { module: "blockchain", method: "blockchainAccountInspect" },
              { module: "blockchain", method: "accountInspect" },
              { module: "accounts", method: "getAccount" }
            ];
            
            // Проверяем, является ли этот метод одним из тех, что требуют accountId
            const isAccountIdMethod = accountIdMethods.some(
              item => item.module.toLowerCase() === module.toLowerCase() && 
                     (item.method.toLowerCase() === method.toLowerCase() || 
                      item.method.toLowerCase().includes(method.toLowerCase()) || 
                      method.toLowerCase().includes(item.method.toLowerCase()))
            );
            
            if (isAccountIdMethod) {
              // Получаем accountId из params, который может быть undefined
              const accountId = params ? 
                (params.accountId || params.address || params.addr || params.account) : 
                undefined;

              // Проверяем наличие параметра сети в params и логируем его
              console.error(chalk.magenta(`Method requiring accountId: ${method}`));
              console.error(chalk.magenta(`Params network setting: ${params && params.network ? params.network : 'undefined'}`));
              console.error(chalk.magenta(`Current network being used: ${useTestnet ? 'testnet' : 'mainnet'}`));
              
              if (!accountId || accountId === "undefined") {
                console.error(chalk.red(`Missing required parameter 'accountId' for ${module}.${method}`));
                return {
                  content: [
                    { 
                      type: "text", 
                      text: JSON.stringify({
                        error: true,
                        module: module,
                        method: method,
                        message: "Missing required parameter 'accountId'",
                        details: `Method ${method} requires one of these parameters: accountId, address, addr, or account`
                      })
                    }
                  ],
                  isError: true,
                };
              }
              
              // Преобразуем в строку для правильной передачи в API
              console.error(chalk.yellow(`Calling ${module}.${method} with accountId: ${accountId}`));
              
              // accountId должен передаваться напрямую, а не в объекте params
              try {
                const result = await requestWrapper.callMethod(module, method, accountId);
                console.error(chalk.green(`Successfully called ${module}.${method}`));
                
                // Возвращаем результат напрямую как JSON-объект
                return {
                  content: [
                    { 
                      type: "text", 
                      text: JSON.stringify({
                        result: result
                      })
                    }
                  ],
                };
              } catch (methodError) {
                console.error(chalk.red(`Error calling ${module}.${method}:`), methodError);
                
                // Проверяем, является ли ошибка объектом Response
                if (methodError && typeof methodError === 'object' && 
                   (methodError.constructor?.name === 'Response' || 
                    ('json' in methodError && typeof methodError.json === 'function'))) {
                  
                  const response = methodError as any;
                  console.error(chalk.yellow(`Got Response error with status: ${response.status} ${response.statusText}`));
                  
                  try {
                    // Пытаемся получить детали ошибки из JSON
                    const errorBody = await response.clone().json();
                    return {
                      content: [
                        { 
                          type: "text", 
                          text: JSON.stringify({
                            error: true,
                            module: module,
                            method: method,
                            http_status: response.status,
                            http_statusText: response.statusText,
                            message: (errorBody.error || errorBody.message || `HTTP Error ${response.status}`).toString().replace(/\n/g, ' '),
                            details: JSON.stringify(errorBody)
                          })
                        }
                      ],
                      isError: true,
                    };
                  } catch (jsonError) {
                    try {
                      // Если не получилось распарсить JSON, пробуем получить текст
                      const errorText = await response.clone().text();
                      return {
                        content: [
                          { 
                            type: "text", 
                            text: JSON.stringify({
                              error: true,
                              module: module,
                              method: method,
                              http_status: response.status,
                              http_statusText: response.statusText,
                              message: (errorText || `HTTP Error ${response.status}`).replace(/\n/g, ' '),
                              details: "Failed to parse error details"
                            })
                          }
                        ],
                        isError: true,
                      };
                    } catch (textError) {
                      // Если и текст не удалось получить
                      return {
                        content: [
                          { 
                            type: "text", 
                            text: JSON.stringify({
                              error: true,
                              module: module,
                              method: method,
                              http_status: response.status,
                              http_statusText: response.statusText,
                              message: `HTTP Error ${response.status} ${response.statusText}`.replace(/\n/g, ' '),
                              details: "Failed to extract error details"
                            })
                          }
                        ],
                        isError: true,
                      };
                    }
                  }
                }
                
                // Обработка обычных ошибок
                return {
                  content: [
                    { 
                      type: "text", 
                      text: JSON.stringify({
                        error: true,
                        module: module,
                        method: method,
                        message: methodError instanceof Error 
                          ? methodError.message.replace(/\n/g, ' ') 
                          : methodError && typeof methodError === 'object' 
                            ? JSON.stringify(methodError).replace(/\n/g, ' ') 
                            : String(methodError),
                        details: methodError instanceof Error 
                          ? methodError.stack?.replace(/\n/g, ' ') 
                          : ""
                      })
                    }
                  ],
                  isError: true,
                };
              }
            }
            
            // Обработка всех остальных методов
            const result = await requestWrapper.callMethod(module, method, ...callArgs);
            
            // Подробное логирование полученного результата
            console.error(chalk.green(`Received result from ${module}.${method}:`));
            console.error(`Result type: ${result ? (typeof result) : 'null'}`);
            
            // Универсальная обработка объекта Response
            if (result && typeof result === 'object') {
              // Проверяем, является ли объект Response объектом (несколькими способами)
              const isResponse = 
                // Способ 1: проверка имени конструктора
                (result.constructor && result.constructor.name === 'Response') ||
                // Способ 2: проверка наличия методов Response
                ('json' in result && typeof result.json === 'function' && 
                 'text' in result && typeof result.text === 'function' &&
                 'status' in result && typeof result.status === 'number') ||
                // Способ 3: проверка наличия прототипа Response
                (Object.prototype.toString.call(result) === '[object Response]');
              
              if (isResponse) {
                const response = result as any;
                console.error(chalk.yellow(`Detected Response object, processing response...`));
                
                // Проверяем статус ответа
                if (!response.ok) {
                  console.error(chalk.red(`Response error: ${response.status} ${response.statusText}`));
                  
                  // Пытаемся получить детали ошибки
                  try {
                    const errorResponse = await response.clone().json();
                    console.error(chalk.red(`Error details:`, errorResponse));
                    
                    return {
                      content: [
                        { 
                          type: "text", 
                          text: JSON.stringify({
                            error: true,
                            module: module,
                            method: method,
                            http_status: response.status,
                            http_statusText: response.statusText,
                            message: (errorResponse.error || errorResponse.message || "API error").toString().replace(/\n/g, ' '),
                            details: errorResponse
                          })
                        }
                      ],
                      isError: true,
                    };
                  } catch (errorParseError) {
                    try {
                      // Если JSON не удался, пытаемся получить текст ошибки
                      const errorText = await response.clone().text();
                      
                      return {
                        content: [
                          { 
                            type: "text", 
                            text: JSON.stringify({
                              error: true,
                              module: module,
                              method: method,
                              http_status: response.status,
                              http_statusText: response.statusText,
                              message: (errorText || `HTTP Error ${response.status}`).replace(/\n/g, ' '),
                              details: "Failed to parse error details"
                            })
                          }
                        ],
                        isError: true,
                      };
                    } catch (textError) {
                      // Если и текст не удался, возвращаем базовую информацию об ошибке
                      return {
                        content: [
                          { 
                            type: "text", 
                            text: JSON.stringify({
                              error: true,
                              module: module,
                              method: method,
                              http_status: response.status,
                              http_statusText: response.statusText,
                              message: `HTTP Error ${response.status} ${response.statusText}`.replace(/\n/g, ' '),
                              details: "Failed to extract error details"
                            })
                          }
                        ],
                        isError: true,
                      };
                    }
                  }
                }
                
                // Если ответ успешный, обрабатываем как обычно
                try {
                  // Пытаемся получить JSON из ответа
                  const responseObj = await response.clone().json();
                  console.error(chalk.green(`Successfully parsed JSON from Response`));
                  return {
                    content: [
                      { 
                        type: "text", 
                        text: JSON.stringify({
                          result: responseObj
                        })
                      }
                    ],
                  };
                } catch (jsonError) {
                  console.error(chalk.yellow(`Failed to parse JSON, trying text...`));
                  
                  try {
                    // Если JSON не удался, пытаемся получить текст
                    const responseText = await response.clone().text();
                    // Попытка распарсить текст как JSON
                    try {
                      const parsedJSON = JSON.parse(responseText);
                      console.error(chalk.green(`Successfully parsed text as JSON`));
                      return {
                        content: [
                          { 
                            type: "text", 
                            text: JSON.stringify({
                              result: parsedJSON
                            })
                          }
                        ],
                      };
                    } catch (jsonParseError) {
                      // Если и это не удалось, возвращаем текст как есть
                      console.error(chalk.yellow(`Text is not JSON, returning as plain text`));
                      return {
                        content: [
                          { 
                            type: "text", 
                            text: JSON.stringify({
                              result: responseText
                            })
                          }
                        ],
                      };
                    }
                  } catch (textError) {
                    console.error(chalk.red(`Failed to extract text from Response:`, textError));
                    // Если и текст не удалось получить, возвращаем информацию об ошибке
                    return {
                      content: [
                        { 
                          type: "text", 
                          text: JSON.stringify({
                            error: true,
                            module: module,
                            method: method,
                            message: "Failed to extract data from Response",
                            response_info: {
                              status: response.status,
                              statusText: response.statusText,
                              headers: Array.from(response.headers?.entries() || [])
                            }
                          })
                        }
                      ],
                      isError: true,
                    };
                  }
                }
              }
            }
            
            // Check if the result is an object with an error field
            if (result && typeof result === 'object' && 'error' in result) {
              console.error(chalk.red(`API returned error object:`, result));
              return {
                content: [
                  { 
                    type: "text", 
                    text: JSON.stringify({
                      error: true,
                      api_error: result
                    })
                  }
                ],
                isError: true,
              };
            }
            
            // If we got here, return the result as is
            return {
              content: [
                { 
                  type: "text", 
                  text: JSON.stringify({
                    result: result
                  })
                }
              ],
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(chalk.red(`Error calling ${module}.${method}:`), error);
            
            // Проверяем, является ли ошибка объектом Response
            if (error && typeof error === 'object' && 
               (error.constructor?.name === 'Response' || 
                ('json' in error && typeof error.json === 'function'))) {
              
              const response = error as any;
              console.error(chalk.yellow(`Got Response error with status: ${response.status} ${response.statusText}`));
              
              try {
                // Пытаемся получить детали ошибки из JSON
                const errorBody = await response.clone().json();
                return {
                  content: [{ 
                    type: "text", 
                    text: JSON.stringify({
                      error: true,
                      module: module,
                      method: method,
                      http_status: response.status,
                      http_statusText: response.statusText,
                      message: (errorBody.error || errorBody.message || `HTTP Error ${response.status}`).toString().replace(/\n/g, ' '),
                      details: JSON.stringify(errorBody)
                    })
                  }],
                  isError: true,
                };
              } catch (jsonError) {
                try {
                  // Если не получилось распарсить JSON, пробуем получить текст
                  const errorText = await response.clone().text();
                  return {
                    content: [{ 
                      type: "text", 
                      text: JSON.stringify({
                        error: true,
                        module: module,
                        method: method,
                        http_status: response.status,
                        http_statusText: response.statusText,
                        message: (errorText || `HTTP Error ${response.status}`).replace(/\n/g, ' '),
                        details: "Failed to parse error details"
                      })
                    }],
                    isError: true,
                  };
                } catch (textError) {
                  // Если и текст не удалось получить
                  return {
                    content: [{ 
                      type: "text", 
                      text: JSON.stringify({
                        error: true,
                        module: module,
                        method: method,
                        http_status: response.status,
                        http_statusText: response.statusText,
                        message: `HTTP Error ${response.status} ${response.statusText}`.replace(/\n/g, ' '),
                        details: "Failed to extract error details"
                      })
                    }],
                    isError: true,
                  };
                }
              }
            }
            
            // More detailed error information
            let errorDetails = '';
            if (error instanceof Error) {
              errorDetails = `Error details: ${error.stack || 'No stack trace available'}`;
            }
            
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify({
                  error: true,
                  module: module,
                  method: method,
                  message: errorMessage.replace(/\n/g, ' '),
                  details: errorDetails.replace(/\n/g, ' ')
                })
              }],
              isError: true,
            };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({
                error: true,
                message: errorMessage
              })
            }],
            isError: true,
          };
        }
      }
      
      case "list_modules": {
        const parsed = ListModulesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_modules: ${parsed.error}`);
        }
        
        const { network } = parsed.data;
        
        // Determine which network to use - from request or from server settings
        const useTestnet = network === 'testnet' || (network === undefined && isTestnet);
        
        // Create a wrapper for the specific network
        const networkWrapper = new TonApiCliWrapper({
          testnet: useTestnet,
          apiKey,
          skipApiKeyCheck: true,
          moduleFilter: moduleFilter.length > 0 ? moduleFilter : undefined
        });
        
        const { modules: sortedModules, methodsByModule } = networkWrapper.getSortedModulesAndMethods();
        
        // Создаем структурированный JSON объект с информацией о модулях
        const modulesData = sortedModules.map(module => {
          const methods = methodsByModule[module];
          return {
            name: module,
            methods_count: methods.length,
            description: getModuleDescription(module)
          };
        });
        
        // Возвращаем JSON-структуру вместо форматированного текста
        return {
          content: [
            { 
              type: "text", 
              text: JSON.stringify({
                network: useTestnet ? 'testnet' : 'mainnet',
                modules: modulesData
              })
            }
          ],
        };
      }
      
      case "list_methods": {
        const parsed = ListMethodsArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_methods: ${parsed.error}`);
        }
        
        const { module, network } = parsed.data;
        
        // Determine which network to use - from request or from server settings
        const useTestnet = network === 'testnet' || (network === undefined && isTestnet);
        
        // Create a wrapper for the specific network
        const networkWrapper = new TonApiCliWrapper({
          testnet: useTestnet,
          apiKey,
          skipApiKeyCheck: true,
          moduleFilter: moduleFilter.length > 0 ? moduleFilter : undefined
        });
        
        if (!networkWrapper.hasModule(module)) {
          throw new Error(`Module ${module} not found on ${useTestnet ? 'testnet' : 'mainnet'}`);
        }
        
        const methods = networkWrapper.getModuleMethods(module).sort();
        
        // Создаем структурированный JSON объект с информацией о методах
        const methodsData = methods.map(methodName => {
          return {
            name: methodName,
            description: networkWrapper.getMethodDescription(module, methodName) || 'No description available',
            signature: networkWrapper.getMethodSignature(module, methodName) || 'Signature unavailable'
          };
        });
        
        // Возвращаем JSON-структуру вместо форматированного текста
        return {
          content: [
            { 
              type: "text", 
              text: JSON.stringify({
                network: useTestnet ? 'testnet' : 'mainnet',
                module: module,
                methods: methodsData
              })
            }
          ],
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ 
        type: "text", 
        text: JSON.stringify({
          error: true,
          message: errorMessage.replace(/\n/g, ' ')
        })
      }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  
  // Перенаправляем все отладочные сообщения в stderr, а не stdout
  console.error(chalk.green('TON API MCP Server starting up...'));
  console.error(chalk.blue(`Network: ${isTestnet ? 'testnet' : 'mainnet'}`));
  console.error(chalk.blue(`API Key: ${apiKey ? 'provided' : 'not provided - will use TON_API_KEY env variable'}`));
  if (moduleFilter.length > 0) {
    console.error(chalk.blue(`Module filter: ${moduleFilter.join(', ')}`));
  }
  
  // Check if we have tools from SDK analysis
  const { modules, methodsByModule } = wrapper.getSortedModulesAndMethods();
  console.error(chalk.green(`Found ${modules.length} API modules with ${modules.reduce((total, module) => total + methodsByModule[module].length, 0)} methods total`));
  
  // Добавим обработку сигналов завершения для корректного выхода
  process.on('SIGINT', () => {
    console.error(chalk.yellow('Received SIGINT signal, shutting down server'));
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.error(chalk.yellow('Received SIGTERM signal, shutting down server'));
    process.exit(0);
  });
  
  // Для отладки добавим обработчик завершения stdin
  process.stdin.on('end', () => {
    console.error(chalk.yellow('stdin stream ended, server will continue running until explicitly terminated'));
  });
  
  await server.connect(transport);
  console.error(chalk.green('TON API MCP Server running on stdio'));
}

runServer().catch((error) => {
  console.error(chalk.red("Fatal error running server:"), error);
  process.exit(1);
});