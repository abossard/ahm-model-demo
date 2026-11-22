targetScope = 'resourceGroup'

param eventHubAuthorizationRuleId string
param eventHubName string
param webContainerAppName string
param mcpContainerAppName string
param containerEnvironmentName string
param registryName string
param foundryAccountName string
param foundryProjectName string
param storageAccountName string
param vnetName string
param privateEndpointName string
param privateDnsZoneName string
param subnetNetworkSecurityGroupIds array
param workspaceName string
param applicationInsightsName string
param healthModelName string
param designHealthModelName string

var allLogs = [
  {
    categoryGroup: 'allLogs'
    enabled: true
  }
]

var allMetrics = [
  {
    category: 'AllMetrics'
    enabled: true
  }
]

resource webContainerApp 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: webContainerAppName
}

resource mcpContainerApp 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: mcpContainerAppName
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-10-02-preview' existing = {
  name: containerEnvironmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2026-03-01' existing = {
  name: foundryAccountName
}

resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2026-03-01' existing = {
  parent: foundryAccount
  name: foundryProjectName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

resource vnet 'Microsoft.Network/virtualNetworks@2025-07-01' existing = {
  name: vnetName
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2025-07-01' existing = {
  name: privateEndpointName
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' existing = {
  name: privateDnsZoneName
}

// An unbound subnet contributes no settings. Two subnets can share the same group.
var localNsgPrefix = toLower('${resourceGroup().id}/providers/Microsoft.Network/networkSecurityGroups/')
var localNsgIds = filter(subnetNetworkSecurityGroupIds, id => startsWith(toLower(id), localNsgPrefix))
var nsgNames = union(map(localNsgIds, id => toLower(last(split(id, '/')))), [])

resource networkSecurityGroups 'Microsoft.Network/networkSecurityGroups@2024-07-01' existing = [for name in nsgNames: {
  name: name
}]

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

resource healthModel 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: healthModelName
}

resource designHealthModel 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: designHealthModelName
}

resource webContainerAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: webContainerApp
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    metrics: allMetrics
  }
}

resource mcpContainerAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: mcpContainerApp
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    metrics: allMetrics
  }
}

resource containerEnvironmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: containerEnvironment
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource registryDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: registry
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource foundryAccountDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: foundryAccount
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource foundryProjectDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: foundryProject
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource storageAccountDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: storageAccount
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    metrics: allMetrics
  }
}

resource blobServiceDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: blobService
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource vnetDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: vnet
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource privateEndpointDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: privateEndpoint
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    metrics: allMetrics
  }
}

resource privateDnsDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: privateDnsZone
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    metrics: allMetrics
  }
}

resource networkSecurityGroupDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = [for (name, i) in nsgNames: {
  name: 'to-event-hub'
  scope: networkSecurityGroups[i]
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
  }
}]

resource workspaceDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: workspace
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource applicationInsightsDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: applicationInsights
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource healthModelDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: healthModel
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

resource designHealthModelDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-event-hub'
  scope: designHealthModel
  properties: {
    eventHubAuthorizationRuleId: eventHubAuthorizationRuleId
    eventHubName: eventHubName
    logs: allLogs
    metrics: allMetrics
  }
}

output diagnosticSettingCount int = 15 + length(nsgNames)
