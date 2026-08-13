targetScope = 'resourceGroup'

@description('Name of the Azure Health Model these entities belong to.')
param modelName string

@description('Authentication setting the signal groups query Azure through.')
param authenticationSettingName string

@description('Action group notified when the root entity turns unhealthy.')
param rootActionGroupId string

@description('Resource IDs the health model reads signals from, sourced from the access module so the read grants exist first.')
param monitoredResources object

// Must match availability-tests.bicep's availabilityTestName; tests/test_app.py asserts they agree.
param availabilityTestName string = 'Health Pulse home page'

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

resource root 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: modelName
  properties: {
    displayName: 'Movie Request Experience'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 560
      y: 40
    }
    alerts: {
      unhealthy: {
        severity: 'Sev2'
        description: 'The movie request journey is unhealthy.'
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
// aggregate the system flows they depend on. Entity name kept as 'request-journey' because
// scripts/demo-failure.sh polls it by name.
resource requestJourney 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'request-journey'
  properties: {
    displayName: 'Do A Queue Thingy'
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

resource sendHealthReports 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-send-health-reports'
  properties: {
    displayName: 'Send Health Reports'
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

resource viewHealthModel 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-view-health-model'
  properties: {
    displayName: 'View Health Model'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 560
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

resource askCopilot 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-ask-copilot'
  properties: {
    displayName: 'Ask the Health Copilot'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 800
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

// Layer 2 - system flows. Internal processes that enable the user flows. Each is a single entity
// with as many parents as it has user flows; the CloudHealth graph is a DAG, so a shared system
// flow is never duplicated per flow.
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

resource systemDatabase 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-database'
  properties: {
    displayName: 'Database'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 440
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

resource systemQueueing 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-queueing'
  properties: {
    displayName: 'Queueing'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 640
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
      x: 840
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
      x: 1060
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
    displayName: 'Python Container App'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 80
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
          enabled: 'Enabled'
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
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
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
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
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
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'failed-requests'
            displayName: 'Failed application requests'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppRequests | where TimeGenerated > ago(5m) | summarize Value = countif(Success == false)'
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
            name: 'failed-postgres-dependencies'
            displayName: 'Failed PostgreSQL dependencies'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(5m) | where Target has "postgres" or Name has "PostgreSQL" | summarize Value = countif(Success == false)'
            valueColumnName: 'Value'
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
            name: 'failed-queue-dependencies'
            displayName: 'Failed Queue dependencies'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(5m) | where Target has "queue.${environment().suffixes.storage}" or Name has "Queue" | summarize Value = countif(Success == false)'
            valueColumnName: 'Value'
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
            // The trailing isnotnan filter drops the row when no probe has reported, so the
            // signal reads Unknown instead of claiming a healthy zero. See the empty-input
            // gotcha for count-style KQL signals.
            queryText: 'AppAvailabilityResults | where TimeGenerated > ago(15m) | where Name == "${availabilityTestName}" | summarize Value = round(100.0 * countif(Success) / count(), 2) | where isnotnan(Value)'
            valueColumnName: 'Value'
            dataUnit: 'Percent'
            timeGrain: 'PT5M'
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

resource postgres 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'postgres'
  properties: {
    displayName: 'PostgreSQL Flexible Server'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 460
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.postgres
        azureResourceKind: 'PostgreSQLFlexibleServer'
        resourceHealth: {
          enabled: 'Enabled'
        }
        signals: [
          {
            name: 'database-alive'
            displayName: 'Database alive'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
            metricName: 'is_db_alive'
            aggregationType: 'Average'
            dataUnit: 'Count'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'LessThan'
                threshold: 1
              }
            }
          }
          {
            name: 'failed-connections'
            displayName: 'Failed connections'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
            metricName: 'connections_failed'
            aggregationType: 'Total'
            dataUnit: 'Count'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 0
              }
            }
          }
          {
            name: 'cpu-percent'
            displayName: 'CPU percent'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
            metricName: 'cpu_percent'
            aggregationType: 'Average'
            dataUnit: 'Percent'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
          {
            name: 'memory-percent'
            displayName: 'Memory percent'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
            metricName: 'memory_percent'
            aggregationType: 'Average'
            dataUnit: 'Percent'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
          {
            name: 'storage-percent'
            displayName: 'Storage percent'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
            metricName: 'storage_percent'
            aggregationType: 'Average'
            dataUnit: 'Percent'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 90
              }
            }
          }
          {
            name: 'cpu-credits'
            displayName: 'CPU credits remaining'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
            metricName: 'cpu_credits_remaining'
            aggregationType: 'Average'
            dataUnit: 'Count'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'LessThan'
                threshold: 5
              }
            }
          }
        ]
      }
    }
  }
}

resource queueStorage 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'queue-storage'
  properties: {
    displayName: 'Queue Storage'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 640
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.storage
        azureResourceKind: 'StorageAccount'
        resourceHealth: {
          enabled: 'Enabled'
        }
        signals: [
          {
            name: 'availability'
            displayName: 'Storage availability'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.Storage/storageAccounts'
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
            displayName: 'Queue end-to-end latency'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.Storage/storageAccounts'
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
          {
            name: 'transactions'
            displayName: 'Storage transactions'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.Storage/storageAccounts'
            metricName: 'Transactions'
            aggregationType: 'Total'
            dataUnit: 'Count'
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 1000000
              }
            }
          }
          {
            name: 'queue-message-count'
            displayName: 'Queue message count'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.Storage/storageAccounts/queueServices'
            metricName: 'QueueMessageCount'
            aggregationType: 'Average'
            dataUnit: 'Count'
            timeGrain: 'PT1H'
            refreshInterval: 'PT1H'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 100000
              }
            }
          }
        ]
      }
    }
  }
}

resource aksCluster 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'aks-cluster'
  properties: {
    displayName: 'AKS Cluster'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 260
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.aksCluster
        azureResourceKind: 'AksCluster'
        resourceHealth: {
          enabled: 'Enabled'
        }
        signals: [
          {
            name: 'node-cpu'
            displayName: 'Node CPU usage'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.ContainerService/managedClusters'
            metricName: 'node_cpu_usage_percentage'
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
            name: 'node-memory'
            displayName: 'Node memory working set'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.ContainerService/managedClusters'
            metricName: 'node_memory_working_set_percentage'
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
        ]
      }
    }
  }
}

resource agentWebApp 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'agent-web-app'
  properties: {
    displayName: 'Agent Web Container App'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 840
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.agentWebApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Enabled'
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
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
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
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
        ]
      }
    }
  }
}

resource agentAppEntity 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'agent-app'
  properties: {
    displayName: 'Agent Backend Container App'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1020
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.agentApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Enabled'
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
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
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
            timeGrain: 'PT1M'
            refreshInterval: 'PT1M'
            evaluationRules: {
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 95
              }
            }
          }
        ]
      }
    }
  }
}

resource openAiAccount 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'openai-account'
  properties: {
    displayName: 'Azure OpenAI Account'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1200
      y: 490
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.openAi
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
            name: 'failed-arm-operations'
            displayName: 'Failed ARM operations'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AzureActivity | where TimeGenerated > ago(15m) | where CategoryValue == "Administrative" | summarize Value = countif(ActivityStatusValue == "Failed")'
            valueColumnName: 'Value'
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
            name: 'platform-alerts'
            displayName: 'Platform alert activity'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AzureActivity | where TimeGenerated > ago(15m) | where CategoryValue == "Alert" | summarize Value = count()'
            valueColumnName: 'Value'
            dataUnit: 'Count'
            timeGrain: 'PT5M'
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
  sendHealthReports: sendHealthReports.name
  requestJourney: requestJourney.name
  viewHealthModel: viewHealthModel.name
  askCopilot: askCopilot.name
  systemAppHosting: systemAppHosting.name
  systemDatabase: systemDatabase.name
  systemQueueing: systemQueueing.name
  systemAgentRuntime: systemAgentRuntime.name
  systemAiInference: systemAiInference.name
  containerApp: containerApp.name
  aksCluster: aksCluster.name
  postgres: postgres.name
  queueStorage: queueStorage.name
  agentWebApp: agentWebApp.name
  agentApp: agentAppEntity.name
  openAiAccount: openAiAccount.name
  platformContext: platformContext.name
  discoveredTopology: discoveredTopology.name
}

output deterministicEntityCount int = 19
