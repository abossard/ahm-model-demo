targetScope = 'resourceGroup'

param modelName string = 'hm-ahm-movie-demo'
param healthModelLocation string
param containerAppId string
param postgresId string
param storageId string
param logAnalyticsWorkspaceId string
param applicationInsightsId string
param appIdentityPrincipalId string
param healthReportRoleDefinitionId string
param tags object

var authenticationName = 'auth-system'

resource rootActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-ahm-movie-demo-root'
  location: 'global'
  tags: tags
  properties: {
    enabled: true
    groupShortName: 'ahmroot'
  }
}

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: healthModelLocation
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

resource appHealthReportOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: model
  name: guid(model.id, appIdentityPrincipalId, healthReportRoleDefinitionId)
  properties: {
    principalId: appIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: healthReportRoleDefinitionId
  }
}

resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, model.id, 'Reader')
  properties: {
    principalId: model.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'acdd72a7-3385-48ef-bd42-f606fba81ae7'
    )
  }
}

resource monitoringReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, model.id, 'Monitoring Reader')
  properties: {
    principalId: model.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '43d0d8ad-25c7-4714-9337-8ba259a9fe05'
    )
  }
}

resource authentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = {
  parent: model
  name: authenticationName
  properties: {
    displayName: 'Health model system identity'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

resource root 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: modelName
  properties: {
    displayName: 'Movie Request Experience'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 500
      y: 40
    }
    alerts: {
      unhealthy: {
        severity: 'Sev2'
        description: 'The movie request journey is unhealthy.'
        actionGroupIds: [
          rootActionGroup.id
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

resource requestJourney 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'request-journey'
  properties: {
    displayName: 'Request Journey'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 300
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

resource applicationRuntime 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'application-runtime'
  properties: {
    displayName: 'Application Runtime'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 300
      y: 330
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
    }
  }
}

resource containerApp 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'container-app'
  properties: {
    displayName: 'Python Container App'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 300
      y: 470
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: true
      }
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: containerAppId
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
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: logAnalyticsWorkspaceId
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
        ]
      }
    }
  }
  dependsOn: [
    reader
    monitoringReader
  ]
}

resource postgres 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'postgres'
  properties: {
    displayName: 'PostgreSQL Flexible Server'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 140
      y: 650
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: postgresId
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
  dependsOn: [
    reader
    monitoringReader
  ]
}

resource queueStorage 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'queue-storage'
  properties: {
    displayName: 'Queue Storage'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 460
      y: 650
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: storageId
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
  dependsOn: [
    reader
    monitoringReader
  ]
}

resource platformContext 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'platform-context'
  properties: {
    displayName: 'Azure Platform Context'
    healthObjective: 99
    impact: 'Limited'
    canvasPosition: {
      x: 700
      y: 190
    }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: logAnalyticsWorkspaceId
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
  dependsOn: [
    reader
    monitoringReader
  ]
}

resource discoveredTopology 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'discovered-app-topology'
  properties: {
    displayName: 'Discovered Application Topology'
    healthObjective: 99
    impact: 'Suppressed'
    canvasPosition: {
      x: 900
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

resource rootToJourney 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-request-journey'
  properties: {
    parentEntityName: root.name
    childEntityName: requestJourney.name
    displayName: 'serves requests through'
  }
}

resource journeyToRuntime 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-journey-runtime'
  properties: {
    parentEntityName: requestJourney.name
    childEntityName: applicationRuntime.name
    displayName: 'runs on'
  }
}

resource runtimeToApp 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-runtime-container-app'
  properties: {
    parentEntityName: applicationRuntime.name
    childEntityName: containerApp.name
    displayName: 'hosts'
  }
}

resource appToPostgres 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-app-postgres'
  properties: {
    parentEntityName: containerApp.name
    childEntityName: postgres.name
    displayName: 'persists events in'
  }
}

resource appToQueue 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-app-queue'
  properties: {
    parentEntityName: containerApp.name
    childEntityName: queueStorage.name
    displayName: 'enqueues events in'
  }
}

resource rootToPlatform 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-platform'
  properties: {
    parentEntityName: root.name
    childEntityName: platformContext.name
    displayName: 'observes platform context'
  }
}

resource rootToDiscovery 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-discovery'
  properties: {
    parentEntityName: root.name
    childEntityName: discoveredTopology.name
    displayName: 'supplements with discovery'
  }
}

resource appInsightsDiscovery 'Microsoft.CloudHealth/healthmodels/discoveryrules@2026-05-01-preview' = {
  parent: model
  name: 'discover-app-insights'
  properties: {
    displayName: 'Application Insights topology'
    authenticationSetting: authentication.name
    addRecommendedSignals: 'Enabled'
    addResourceHealthSignal: 'Disabled'
    discoverRelationships: 'Enabled'
    specification: {
      kind: 'ApplicationInsightsTopology'
      applicationInsightsResourceId: applicationInsightsId
    }
  }
  dependsOn: [
    reader
    monitoringReader
    rootToDiscovery
  ]
}

output modelId string = model.id
output modelPrincipalId string = model.identity.principalId
output appHealthReportRoleAssignmentId string = appHealthReportOperator.id
output deterministicEntityCount int = 8
output deterministicRelationshipCount int = 7
