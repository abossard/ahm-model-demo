targetScope = 'resourceGroup'

@description('Name of the Azure Health Model these entities belong to.')
param modelName string

@description('Authentication setting the signal groups query Azure through.')
param authenticationSettingName string

@description('Action group notified when the root entity turns unhealthy.')
param rootActionGroupId string

@description('Resource IDs the health model reads signals from, sourced from the access module so the read grants exist first.')
param monitoredResources object

// Must match availability-tests.bicep's availabilityTestName; tests/test_infra.py asserts they agree.
param availabilityTestName string = 'Health Pulse home page'
param mcpAvailabilityTestName string = 'Azure MCP health'

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

resource root 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: modelName
  properties: {
    displayName: 'Health Pulse'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 560
      y: 40
    }
    alerts: {
      unhealthy: {
        severity: 'Sev2'
        description: 'Health Pulse is unhealthy.'
        actionGroupIds: [
          rootActionGroupId
        ]
      }
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

// Layer 1 - user flows. The paths a user takes through the app. No signals of their own; they
// aggregate the system flows they depend on.
resource viewHealthModel 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-view-health-model'
  properties: {
    displayName: 'View Health Model'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 80
      y: 190
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

resource sendHealthReports 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-send-health-reports'
  properties: {
    displayName: 'Send Health Reports'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 320
      y: 190
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

resource runAgentTasks 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-run-agent-tasks'
  properties: {
    displayName: 'Run agent tasks'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 740
      y: 190
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

// Layer 2 - system components. Internal parts that enable the user flows. Each is a single entity
// with as many parents as it has user flows; the CloudHealth graph is a DAG, so a shared component
// is never duplicated per flow.
resource systemAppHosting 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-app-hosting'
  properties: {
    displayName: 'App Hosting'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 200
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

resource systemAgentRuntime 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-agent-runtime'
  properties: {
    displayName: 'Agent Runtime'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 530
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

resource systemAiInference 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-ai-inference'
  properties: {
    displayName: 'AI Inference'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 860
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

resource systemSessionStore 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-session-store'
  properties: {
    displayName: 'Session Store'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1080
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

// Layer 3 - the Azure resources. Every health signal in the model lives here.

resource containerApp 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'container-app'
  properties: {
    displayName: 'Web Container App'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 200
      y: 490
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.containerApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: [
          {
            name: 'cpu-percentage'
            displayName: 'CPU percentage'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.App/containerApps'
            metricName: 'CpuPercentage'
            aggregationType: 'Average'
            dataUnit: 'Percent'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
          {
            name: 'memory-percentage'
            displayName: 'Memory percentage'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.App/containerApps'
            metricName: 'MemoryPercentage'
            aggregationType: 'Average'
            dataUnit: 'Percent'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
          {
            name: 'response-time'
            displayName: 'HTTP response time'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.App/containerApps'
            metricName: 'ResponseTime'
            aggregationType: 'Average'
            dataUnit: 'MilliSeconds'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 5000
              }
            }
          }
        ]
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'failed-requests'
            displayName: 'Failed application requests (HTTP 5xx)'
            signalKind: 'LogAnalyticsQuery'
            // Auto-instrumentation marks every 4xx as unsuccessful, so scanner 404s and 405s would count. Only 5xx
            // (including unhandled exceptions, which answer 500) say the server failed.
            queryText: 'AppRequests | where TimeGenerated > ago(5m) | summarize Value = countif(toint(ResultCode) >= 500)'
            valueColumnName: 'Value'
            dataUnit: 'Count'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 2
              }
            }
          }
          {
            name: 'exceptions'
            displayName: 'Application exceptions'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppExceptions | where TimeGenerated > ago(5m) | summarize Value = count()'
            valueColumnName: 'Value'
            dataUnit: 'Count'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 2
              }
            }
          }
          {
            name: 'availability-test'
            displayName: 'Synthetic availability'
            signalKind: 'LogAnalyticsQuery'
            // The trailing NaN filter drops the row when no probe has reported, so the
            // signal reads Unknown instead of claiming a healthy zero. See the empty-input
            // gotcha for count-style KQL signals.
            queryText: 'AppAvailabilityResults | where TimeGenerated > ago(15m) | where Name == "${availabilityTestName}" | summarize Value = round(100.0 * countif(Success) / count(), 2) | where not(isnan(Value))'
            valueColumnName: 'Value'
            dataUnit: 'Percent'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'LessThan'
                threshold: 100
              }
              unhealthyRule: {
                operator: 'LessThan'
                threshold: 67
              }
            }
          }
        ]
      }
    }
  }
}

// Bound to the project, which Resource Health does not cover. The signals read the web app's own
// foundry.agent.* spans; the web app is the only caller of the hosted agent. An idle window leaves the
// failure count at 0 (Healthy) and drops the latency row, so latency reads Unknown instead of a healthy zero.
// The latency signal measures how long a whole Task run takes (foundry.agent.respond, one span per Task). A normal
// Task takes minutes: the agent budgets 240 s (explain), 360 s (review) and 420 s (design) and the web app fails a
// Task at 600 s. So the thresholds sit above the budgets: Degraded above 450 s, Unhealthy above 570 s, close to the
// timeout. An inline signal has no description property, so this comment and the display name say what it measures.
resource hostedAgent 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'hosted-agent'
  properties: {
    displayName: 'Foundry Hosted Agent'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 420
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.foundryProject
        azureResourceKind: 'CognitiveServicesAccount'
        resourceHealth: {
          enabled: 'Disabled'
        }
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'agent-task-failures'
            displayName: 'Failed agent tasks'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where Name startswith "foundry.agent." | summarize Value = countif(Success == false)'
            valueColumnName: 'Value'
            dataUnit: 'Count'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 0
              }
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 2
              }
            }
          }
          {
            name: 'agent-task-latency'
            displayName: 'Agent Task duration (p95, whole Task)'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where Name startswith "foundry.agent." | summarize Value = percentile(DurationMs, 95) | where not(isnan(Value))'
            valueColumnName: 'Value'
            dataUnit: 'MilliSeconds'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 450000
              }
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 570000
              }
            }
          }
        ]
      }
    }
  }
}

// The Azure MCP server the agent reads Azure through. Resource Health does not cover Container Apps. The server cannot
// export requests to Application Insights (its exporter has no credential and the component accepts only Entra
// tokens), so there is no request-based signal: the availability probe reports it instead. Thresholds are assumptions:
// no traffic has run through the server yet, and tool calls that query Log Analytics take seconds.
resource mcpServer 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'mcp-server'
  properties: {
    displayName: 'Azure MCP Server'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 640
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.mcpApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: [
          {
            name: 'cpu-percentage'
            displayName: 'CPU percentage'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.App/containerApps'
            metricName: 'CpuPercentage'
            aggregationType: 'Average'
            dataUnit: 'Percent'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
          {
            name: 'memory-percentage'
            displayName: 'Memory percentage'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.App/containerApps'
            metricName: 'MemoryPercentage'
            aggregationType: 'Average'
            dataUnit: 'Percent'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
          {
            name: 'response-time'
            displayName: 'HTTP response time'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.App/containerApps'
            metricName: 'ResponseTime'
            aggregationType: 'Average'
            dataUnit: 'MilliSeconds'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 10000
              }
            }
          }
        ]
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'availability-test'
            displayName: 'Synthetic availability'
            signalKind: 'LogAnalyticsQuery'
            // The trailing NaN filter drops the row when no probe has reported, so the signal reads Unknown
            // instead of claiming a healthy zero.
            queryText: 'AppAvailabilityResults | where TimeGenerated > ago(15m) | where Name == "${mcpAvailabilityTestName}" | summarize Value = round(100.0 * countif(Success) / count(), 2) | where not(isnan(Value))'
            valueColumnName: 'Value'
            dataUnit: 'Percent'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'LessThan'
                threshold: 100
              }
              unhealthyRule: {
                operator: 'LessThan'
                threshold: 67
              }
            }
          }
        ]
      }
    }
  }
}

resource foundryAccount 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'foundry-account'
  properties: {
    displayName: 'Foundry Account'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 860
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.foundryAccount
        azureResourceKind: 'CognitiveServicesAccount'
        resourceHealth: {
          enabled: 'Enabled'
        }
        signals: [
          {
            name: 'client-errors'
            displayName: 'Client errors'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.CognitiveServices/accounts'
            metricName: 'ClientErrors'
            aggregationType: 'Total'
            dataUnit: 'Count'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 10
              }
            }
          }
          {
            name: 'server-errors'
            displayName: 'Server errors'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.CognitiveServices/accounts'
            metricName: 'ServerErrors'
            aggregationType: 'Total'
            dataUnit: 'Count'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 0
              }
            }
          }
          {
            name: 'throttled-requests'
            displayName: 'Throttled model requests'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.CognitiveServices/accounts'
            metricName: 'ModelRequests'
            aggregationType: 'Total'
            dimensionFilter: 'StatusCode eq \'429\''
            dataUnit: 'Count'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 0
              }
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 10
              }
            }
          }
        ]
      }
    }
  }
}

// Bound to the blob service, which Resource Health does not cover.
resource sessionStorage 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'session-storage'
  properties: {
    displayName: 'Session Storage'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1080
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.sessionsBlobService
        azureResourceKind: 'StorageAccount'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: [
          {
            name: 'availability'
            displayName: 'Blob availability'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.Storage/storageAccounts/blobServices'
            metricName: 'Availability'
            aggregationType: 'Average'
            dataUnit: 'Percent'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'LessThan'
                threshold: 99
              }
            }
          }
          {
            name: 'end-to-end-latency'
            displayName: 'Blob end-to-end latency'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.Storage/storageAccounts/blobServices'
            metricName: 'SuccessE2ELatency'
            aggregationType: 'Average'
            dataUnit: 'MilliSeconds'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 5000
              }
            }
          }
        ]
      }
    }
  }
}

resource platformContext 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'platform-context'
  properties: {
    displayName: 'Azure Platform Context'
    healthObjective: 99
    impact: 'Limited'
    canvasPosition: {
      x: 1300
      y: 190
    }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'service-health'
            displayName: 'Critical Service Health events'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AzureActivity | where TimeGenerated > ago(15m) | where CategoryValue == "ServiceHealth" | summarize Value = countif(Level in ("Error", "Critical"))'
            valueColumnName: 'Value'
            dataUnit: 'Count'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 0
              }
            }
          }
          {
            name: 'failed-arm-operations'
            displayName: 'Failed ARM operations in this resource group'
            signalKind: 'LogAnalyticsQuery'
            // The activity log is subscription-wide and the workspace records a failed operation as "Failure", not
            // "Failed". Other workloads in the subscription must not turn this model degraded.
            queryText: 'AzureActivity | where TimeGenerated > ago(15m) | where CategoryValue == "Administrative" | where ResourceGroup =~ "${resourceGroup().name}" | summarize Value = countif(ActivityStatusValue in ("Failed", "Failure"))'
            valueColumnName: 'Value'
            dataUnit: 'Count'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 0
              }
            }
          }
          {
            name: 'platform-alerts'
            displayName: 'Platform alert activity'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AzureActivity | where TimeGenerated > ago(15m) | where CategoryValue == "Alert" | summarize Value = count()'
            valueColumnName: 'Value'
            dataUnit: 'Count'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 20
              }
            }
          }
        ]
      }
    }
  }
}

resource discoveredTopology 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'discovered-app-topology'
  properties: {
    displayName: 'Discovered Application Topology'
    healthObjective: 99
    impact: 'Suppressed'
    canvasPosition: {
      x: 1520
      y: 190
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

output entityNames object = {
  root: root.name
  viewHealthModel: viewHealthModel.name
  sendHealthReports: sendHealthReports.name
  runAgentTasks: runAgentTasks.name
  systemAppHosting: systemAppHosting.name
  systemAgentRuntime: systemAgentRuntime.name
  systemAiInference: systemAiInference.name
  systemSessionStore: systemSessionStore.name
  containerApp: containerApp.name
  hostedAgent: hostedAgent.name
  mcpServer: mcpServer.name
  foundryAccount: foundryAccount.name
  sessionStorage: sessionStorage.name
  platformContext: platformContext.name
  discoveredTopology: discoveredTopology.name
}

output deterministicEntityCount int = 15
