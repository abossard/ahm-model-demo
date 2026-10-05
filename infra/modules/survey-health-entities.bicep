targetScope = 'resourceGroup'

param modelName string
param containerAppId string
param postgresId string
param workspaceId string
param monitoredResources object

param authenticationName string
var rollup = {
  aggregationType: 'WorstOf'
  ignoreUnknown: false
}

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

resource authentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' existing = {
  parent: model
  name: authenticationName
}


var logicalNodes = [
  { name: modelName, displayName: modelName, x: 600, y: 0, operation: '' }
  { name: 'author-survey', displayName: 'Author Survey', x: 200, y: 200, operation: '' }
  { name: 'join-and-answer', displayName: 'Join and Answer', x: 600, y: 200, operation: '' }
  { name: 'view-results', displayName: 'View Results', x: 1000, y: 200, operation: '' }
  { name: 'definition-management', displayName: 'Survey Definition Management', x: 0, y: 400, operation: 'author_save' }
  { name: 'definition-read', displayName: 'Survey Definition Read', x: 300, y: 400, operation: 'join_read' }
  { name: 'ballot-persistence', displayName: 'Browser Recognition and Ballot Persistence', x: 600, y: 400, operation: 'ballot_save' }
  { name: 'results-aggregation', displayName: 'Results Aggregation', x: 900, y: 400, operation: 'results_read' }
  { name: 'survey-persistence', displayName: 'Survey Persistence', x: 300, y: 600, operation: '' }
  { name: 'app-hosting', displayName: 'App Hosting', x: 900, y: 600, operation: 'readiness' }
]
var operationNodes = filter(logicalNodes, node => !empty(node.operation))

resource logical 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = [for node in logicalNodes: {
  parent: model
  name: node.name
  properties: {
    displayName: node.displayName
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: { x: node.x, y: node.y }
    signalGroups: {
      dependencies: rollup
    }
  }
}]

resource operationEvidence 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = [for (node, index) in operationNodes: {
  parent: model
  name: '${node.name}-evidence'
  properties: {
    displayName: '${node.displayName} operation evidence'
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: { x: index * 300, y: 1000 }
    signalGroups: {
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: '${replace(node.operation, '_', '-')}-outcome'
            displayName: '${node.displayName} recent operation success'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppRequests | where TimeGenerated > ago(5m) | where AppRoleName == "ahm-survey" | where Name == "${node.operation}" | summarize Samples = count(), Failures = countif(Success == false) | where Samples > 0 | project Value = 100.0 * (Samples - Failures) / Samples'
            valueColumnName: 'Value'
            dataUnit: 'Percent'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: {
              degradedRule: { operator: 'LessThan', threshold: 100 }
              unhealthyRule: { operator: 'LessThan', threshold: 95 }
            }
          }
        ]
      }
    }
  }
}]

resource appResource 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-survey-app'
  properties: {
    displayName: last(split(containerAppId, '/'))
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: { x: 1000, y: 800 }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: monitoredResources.containerApp
        azureResourceKind: 'ContainerApp'
        resourceHealth: { enabled: 'Enabled' }
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
            evaluationRules: { unhealthyRule: { operator: 'GreaterThan', threshold: 95 } }
          }
        ]
      }
    }
  }
}

resource databaseResource 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-postgres'
  properties: {
    displayName: last(split(postgresId, '/'))
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: { x: 200, y: 800 }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: monitoredResources.postgres
        azureResourceKind: 'PostgreSQLFlexibleServer'
        resourceHealth: { enabled: 'Enabled' }
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
            evaluationRules: { unhealthyRule: { operator: 'LessThan', threshold: 1 } }
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
            evaluationRules: { unhealthyRule: { operator: 'GreaterThan', threshold: 0 } }
          }
        ]
      }
    }
  }
}

resource telemetryResource 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: 'azure-workspace'
  properties: {
    displayName: last(split(workspaceId, '/'))
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: { x: 600, y: 800 }
    signalGroups: {
      azureResource: {
        authenticationSetting: authentication.name
        azureResourceId: monitoredResources.logAnalyticsWorkspace
        azureResourceKind: 'LogAnalyticsWorkspace'
        resourceHealth: { enabled: 'Enabled' }
      }
      azureLogAnalytics: {
        authenticationSetting: authentication.name
        logAnalyticsWorkspaceResourceId: monitoredResources.logAnalyticsWorkspace
        signals: [
          {
            name: 'recent-survey-requests'
            displayName: 'Recent survey request outcomes'
            signalKind: 'LogAnalyticsQuery'
            queryText: 'AppRequests | where TimeGenerated > ago(5m) | where AppRoleName == "ahm-survey" | summarize Samples = count(), Failures = countif(Success == false) | where Samples > 0 | project Value = 100.0 * (Samples - Failures) / Samples'
            valueColumnName: 'Value'
            dataUnit: 'Percent'
            timeGrain: 'PT5M'
            refreshInterval: 'PT5M'
            evaluationRules: { unhealthyRule: { operator: 'LessThan', threshold: 95 } }
          }
        ]
      }
    }
  }
}

var edges = [
  { parent: modelName, child: 'author-survey' }
  { parent: modelName, child: 'join-and-answer' }
  { parent: modelName, child: 'view-results' }
  { parent: 'author-survey', child: 'definition-management' }
  { parent: 'join-and-answer', child: 'definition-read' }
  { parent: 'join-and-answer', child: 'ballot-persistence' }
  { parent: 'view-results', child: 'results-aggregation' }
  { parent: 'definition-management', child: 'survey-persistence' }
  { parent: 'definition-read', child: 'survey-persistence' }
  { parent: 'ballot-persistence', child: 'survey-persistence' }
  { parent: 'results-aggregation', child: 'survey-persistence' }
  { parent: 'author-survey', child: 'app-hosting' }
  { parent: 'join-and-answer', child: 'app-hosting' }
  { parent: 'view-results', child: 'app-hosting' }
  { parent: 'survey-persistence', child: 'azure-postgres' }
  { parent: 'app-hosting', child: 'azure-survey-app' }
  { parent: 'definition-management', child: 'azure-workspace' }
  { parent: 'definition-read', child: 'azure-workspace' }
  { parent: 'ballot-persistence', child: 'azure-workspace' }
  { parent: 'results-aggregation', child: 'azure-workspace' }
]

resource relationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [for edge in edges: {
  parent: model
  name: 'r-${edge.parent}-${edge.child}'
  properties: {
    parentEntityName: logical[indexOf(map(logicalNodes, node => node.name), edge.parent)].name
    // ARM evaluates generated dependencies even for the unused logical branch of a resource leaf.
    childEntityName: edge.child == 'azure-postgres' ? databaseResource.name : edge.child == 'azure-survey-app' ? appResource.name : edge.child == 'azure-workspace' ? telemetryResource.name : logical[max(0, indexOf(map(logicalNodes, node => node.name), edge.child))].name
    displayName: 'depends on'
  }
}]

resource evidenceRelationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [for (node, index) in operationNodes: {
  parent: model
  name: 'r-${node.name}-evidence'
  properties: {
    parentEntityName: logical[indexOf(map(logicalNodes, item => item.name), node.name)].name
    childEntityName: operationEvidence[index].name
    displayName: 'requires operation evidence'
  }
}]

output modelName string = model.name
output modelId string = model.id
