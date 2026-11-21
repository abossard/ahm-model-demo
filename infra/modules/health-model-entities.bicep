targetScope = 'resourceGroup'

@description('Name of the Azure Health Model these entities belong to.')
param modelName string

@description('Authentication setting the signal groups query Azure through.')
param authenticationSettingName string

@description('Action group notified when the root entity turns unhealthy.')
param rootActionGroupId string

@description('Application Insights role name used by the web app.')
param appRoleName string

@description('Resource IDs the health model reads signals from, sourced from the access module so the read grants exist first.')
param monitoredResources object

param availabilityTestName string = 'Health Pulse home page'
param mcpAvailabilityTestName string = 'Azure MCP health'

var webMetricSignals = [
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
      degradedRule: {
        operator: 'GreaterThan'
        threshold: 80
      }
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
      degradedRule: {
        operator: 'GreaterThan'
        threshold: 80
      }
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
      degradedRule: {
        operator: 'GreaterThan'
        threshold: 3000
      }
      unhealthyRule: {
        operator: 'GreaterThan'
        threshold: 5000
      }
    }
  }
  {
    name: 'restart-count'
    displayName: 'Container restarts'
    signalKind: 'AzureResourceMetric'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'RestartCount'
    aggregationType: 'Total'
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
        threshold: 1
      }
    }
  }
]

var mcpMetricSignals = [
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
      degradedRule: {
        operator: 'GreaterThan'
        threshold: 80
      }
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
      degradedRule: {
        operator: 'GreaterThan'
        threshold: 80
      }
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
      degradedRule: {
        operator: 'GreaterThan'
        threshold: 7000
      }
      unhealthyRule: {
        operator: 'GreaterThan'
        threshold: 10000
      }
    }
  }
  {
    name: 'restart-count'
    displayName: 'Container restarts'
    signalKind: 'AzureResourceMetric'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'RestartCount'
    aggregationType: 'Total'
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
        threshold: 1
      }
    }
  }
]

var storageMetricSignals = [
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
      degradedRule: {
        operator: 'LessThan'
        threshold: json('99.9')
      }
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
      degradedRule: {
        operator: 'GreaterThan'
        threshold: 2000
      }
      unhealthyRule: {
        operator: 'GreaterThan'
        threshold: 5000
      }
    }
  }
]

var webAvailabilitySignals = [
  {
    name: 'availability-test'
    displayName: 'Synthetic availability'
    signalKind: 'LogAnalyticsQuery'
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

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

resource root 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: modelName
  properties: {
    displayName: 'CORE'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1120
      y: 40
    }
    alerts: {
      unhealthy: {
        severity: 'Sev2'
        description: 'CORE is unhealthy.'
        actionGroupIds: [
          rootActionGroupId
        ]
      }
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource viewHealthModel 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-view-health-model'
  properties: {
    displayName: 'View a health model'
    icon: {
      iconName: 'UserFlow'
    }
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 120
      y: 190
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource sendHealthReports 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-send-health-reports'
  properties: {
    displayName: 'Send a health report'
    icon: {
      iconName: 'UserFlow'
    }
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 520
      y: 190
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource runAgentTasks 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-run-agent-tasks'
  properties: {
    displayName: 'Run a Task'
    icon: {
      iconName: 'UserFlow'
    }
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 1180
      y: 190
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource applyHealthModelChanges 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'flow-apply-health-model-changes'
  properties: {
    displayName: 'Apply approved changes'
    icon: {
      iconName: 'UserFlow'
    }
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: 2120
      y: 190
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource systemAppHosting 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-app-hosting'
  properties: {
    displayName: 'Web and API for viewing'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 20
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'view-route-failures'
            displayName: 'Failed model-view requests'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppRequests | where TimeGenerated > ago(5m) | where AppRoleName == "${appRoleName}" | where Name in ("GET /api/health-models", "GET /api/health-model", "GET /api/health-model/stream", "GET /api/timeline", "GET /api/entities/{entity_name:path}") | summarize Value = countif(toint(ResultCode) >= 500)'
            valueColumnName: 'Value'
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
                threshold: 2
              }
            }
          }
        ]
      }
    }
  }
}

resource systemModelRead 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-model-read'
  properties: {
    displayName: 'Model catalog and history'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 220
      y: 340
    }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'model-read-failures'
            displayName: 'Failed model reads'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name in ("healthmodel.catalog", "healthmodel.read", "healthmodel.timeline", "healthmodel.history") | summarize Value = countif(Success == false)'
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
            name: 'model-read-latency'
            displayName: 'Model read duration (p95)'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name in ("healthmodel.catalog", "healthmodel.read", "healthmodel.timeline", "healthmodel.history") | summarize Value = percentile(DurationMs, 95) | where not(isnan(Value))'
            valueColumnName: 'Value'
            dataUnit: 'MilliSeconds'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 5000
              }
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 40000
              }
            }
          }
        ]
      }
    }
  }
}

resource systemAppHostingReports 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-app-hosting-reports'
  properties: {
    displayName: 'Web and API for reports'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 420
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'report-route-failures'
            displayName: 'Failed report requests'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppRequests | where TimeGenerated > ago(5m) | where AppRoleName == "${appRoleName}" | where Name == "POST /api/entities/{entity_name:path}/health-reports" | summarize Value = countif(toint(ResultCode) >= 500)'
            valueColumnName: 'Value'
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
                threshold: 2
              }
            }
          }
        ]
      }
    }
  }
}

resource systemReportIngest 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-report-ingest'
  properties: {
    displayName: 'Health report ingestion'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 620
      y: 340
    }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'report-ingest-failures'
            displayName: 'Failed report ingestion calls'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name == "healthmodel.report" | summarize Value = countif(Success == false)'
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
        ]
      }
    }
  }
}

resource systemAppHostingTasks 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-app-hosting-tasks'
  properties: {
    displayName: 'Web and API for Tasks'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 820
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'task-route-failures'
            displayName: 'Failed Task requests'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppRequests | where TimeGenerated > ago(5m) | where AppRoleName == "${appRoleName}" | where Name in ("GET /api/sessions", "POST /api/sessions", "GET /api/sessions/{sid}", "POST /api/sessions/{sid}/tasks", "GET /api/sessions/{sid}/tasks/{tid}", "GET /api/sessions/{sid}/tasks/{tid}/events", "GET /api/sessions/{sid}/tasks/{tid}/diff") | summarize Value = countif(toint(ResultCode) >= 500)'
            valueColumnName: 'Value'
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
                threshold: 2
              }
            }
          }
        ]
      }
    }
  }
}

resource systemSessionStore 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-session-store'
  properties: {
    displayName: 'Session and Task storage'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 1020
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'session-store-failures'
            displayName: 'Failed session-store calls'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name startswith "sessions.store." | summarize Value = countif(Success == false)'
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
            name: 'session-store-latency'
            displayName: 'Session-store duration (p95)'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name startswith "sessions.store." | summarize Value = percentile(DurationMs, 95) | where not(isnan(Value))'
            valueColumnName: 'Value'
            dataUnit: 'MilliSeconds'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 2000
              }
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 10000
              }
            }
          }
        ]
      }
    }
  }
}

resource systemAgentRuntime 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-agent-runtime'
  properties: {
    displayName: 'Assistant execution'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 1220
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource systemAiInference 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-ai-inference'
  properties: {
    displayName: 'Model inference'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 1420
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource systemAppHostingApply 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-app-hosting-apply'
  properties: {
    displayName: 'Web and API for Apply'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 2020
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    }
  }
}

resource systemModelWrite 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-model-write'
  properties: {
    displayName: 'Model change writer'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 2220
      y: 340
    }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'apply-request-failures'
            displayName: 'Failed Apply requests'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppRequests | where TimeGenerated > ago(5m) | where AppRoleName == "${appRoleName}" | where Name == "POST /api/sessions/{sid}/tasks/{tid}/apply" | summarize Value = countif(toint(ResultCode) >= 500)'
            valueColumnName: 'Value'
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
                threshold: 2
              }
            }
          }
        ]
      }
    }
  }
}

resource systemApplyState 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'system-apply-state'
  properties: {
    displayName: 'Apply result storage'
    icon: {
      iconName: 'SystemComponent'
    }
    impact: 'Standard'
    canvasPosition: {
      x: 2420
      y: 340
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'apply-state-failures'
            displayName: 'Failed Apply state calls'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name startswith "sessions.store." | summarize Value = countif(Success == false)'
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
            name: 'apply-state-latency'
            displayName: 'Apply state duration (p95)'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name startswith "sessions.store." | summarize Value = percentile(DurationMs, 95) | where not(isnan(Value))'
            valueColumnName: 'Value'
            dataUnit: 'MilliSeconds'
            timeGrain: 'PT15M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 2000
              }
              unhealthyRule: {
                operator: 'GreaterThan'
                threshold: 10000
              }
            }
          }
        ]
      }
    }
  }
}

resource containerApp 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'container-app'
  properties: {
    displayName: 'Container App: ${last(split(monitoredResources.containerApp, '/'))} / View'
    impact: 'Standard'
    canvasPosition: {
      x: 20
      y: 520
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.containerApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: webMetricSignals
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: webAvailabilitySignals
      }
    }
  }
}

resource containerAppReports 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'container-app-reports'
  properties: {
    displayName: 'Container App: ${last(split(monitoredResources.containerApp, '/'))} / Report'
    impact: 'Standard'
    canvasPosition: {
      x: 420
      y: 520
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.containerApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: webMetricSignals
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: webAvailabilitySignals
      }
    }
  }
}

resource containerAppTasks 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'container-app-tasks'
  properties: {
    displayName: 'Container App: ${last(split(monitoredResources.containerApp, '/'))} / Tasks'
    impact: 'Standard'
    canvasPosition: {
      x: 820
      y: 520
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.containerApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: webMetricSignals
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: webAvailabilitySignals
      }
    }
  }
}

resource containerAppApply 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'container-app-apply'
  properties: {
    displayName: 'Container App: ${last(split(monitoredResources.containerApp, '/'))} / Apply'
    impact: 'Standard'
    canvasPosition: {
      x: 2020
      y: 520
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.containerApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: webMetricSignals
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: webAvailabilitySignals
      }
    }
  }
}

resource sessionStorage 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'session-storage'
  properties: {
    displayName: 'Blob Storage: ${last(split(monitoredResources.sessionsStorageAccount, '/'))} / sessions, Tasks'
    impact: 'Standard'
    canvasPosition: {
      x: 1020
      y: 520
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.sessionsStorageAccount
        azureResourceKind: 'StorageAccount'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: storageMetricSignals
      }
    }
  }
}

resource hostedAgent 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'hosted-agent'
  properties: {
    displayName: 'Foundry project: ${last(split(monitoredResources.foundryProject, '/'))} / health-model-agent'
    impact: 'Standard'
    canvasPosition: {
      x: 1220
      y: 520
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
            displayName: 'Failed agent Tasks'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name startswith "foundry.agent." | summarize Value = countif(Success == false)'
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
            queryText: 'AppDependencies | where TimeGenerated > ago(15m) | where AppRoleName == "${appRoleName}" | where Name startswith "foundry.agent." | summarize Value = percentile(DurationMs, 95) | where not(isnan(Value))'
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

resource mcpServer 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'mcp-server'
  properties: {
    displayName: 'Container App: ${last(split(monitoredResources.mcpApp, '/'))}'
    impact: 'Standard'
    canvasPosition: {
      x: 1420
      y: 520
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.mcpApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: mcpMetricSignals
      }
      azureLogAnalytics: {
        authenticationSetting: authenticationSettingName
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'availability-test'
            displayName: 'Synthetic availability'
            signalKind: 'LogAnalyticsQuery'
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
    displayName: 'Foundry account: ${last(split(monitoredResources.foundryAccount, '/'))} / gpt-54-mini'
    impact: 'Standard'
    canvasPosition: {
      x: 1620
      y: 520
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
            displayName: 'Client and throttling errors'
            signalKind: 'AzureResourceMetric'
            metricNamespace: 'Microsoft.CognitiveServices/accounts'
            metricName: 'ClientErrors'
            aggregationType: 'Total'
            dataUnit: 'Count'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: {
                operator: 'GreaterThan'
                threshold: 2
              }
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

resource sessionStorageApply 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'session-storage-apply'
  properties: {
    displayName: 'Blob Storage: ${last(split(monitoredResources.sessionsStorageAccount, '/'))} / sessions, Apply'
    impact: 'Standard'
    canvasPosition: {
      x: 2420
      y: 520
    }
    signalGroups: {
      azureResource: {
        authenticationSetting: authenticationSettingName
        azureResourceId: monitoredResources.sessionsStorageAccount
        azureResourceKind: 'StorageAccount'
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: storageMetricSignals
      }
    }
  }
}

resource platformContext 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'platform-context'
  properties: {
    displayName: 'Azure platform context'
    impact: 'Limited'
    canvasPosition: {
      x: 2620
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
    impact: 'Suppressed'
    canvasPosition: {
      x: 2820
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
  applyHealthModelChanges: applyHealthModelChanges.name
  systemAppHosting: systemAppHosting.name
  systemModelRead: systemModelRead.name
  systemAppHostingReports: systemAppHostingReports.name
  systemReportIngest: systemReportIngest.name
  systemAppHostingTasks: systemAppHostingTasks.name
  systemSessionStore: systemSessionStore.name
  systemAgentRuntime: systemAgentRuntime.name
  systemAiInference: systemAiInference.name
  systemAppHostingApply: systemAppHostingApply.name
  systemModelWrite: systemModelWrite.name
  systemApplyState: systemApplyState.name
  containerApp: containerApp.name
  containerAppReports: containerAppReports.name
  containerAppTasks: containerAppTasks.name
  containerAppApply: containerAppApply.name
  sessionStorage: sessionStorage.name
  hostedAgent: hostedAgent.name
  mcpServer: mcpServer.name
  foundryAccount: foundryAccount.name
  sessionStorageApply: sessionStorageApply.name
  platformContext: platformContext.name
  discoveredTopology: discoveredTopology.name
}

output deterministicEntityCount int = 27
