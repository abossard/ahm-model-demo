targetScope = 'resourceGroup'

@description('Name of the Azure Health Model.')
param modelName string

@description('Authentication setting for Azure-backed signal instances.')
param authenticationSettingName string

@description('Resource IDs from this azd environment.')
param monitoredResources object

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

var profiles = [
  {
    name: 'iot-web-cpu'
    displayName: 'Web app CPU'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'CpuPercentage'
    aggregationType: 'Average'
    dataUnit: 'Percent'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 80
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 95
    azureResourceId: monitoredResources.containerApp
    azureResourceKind: 'ContainerApp'
  }
  {
    name: 'iot-web-memory'
    displayName: 'Web app memory'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'MemoryPercentage'
    aggregationType: 'Average'
    dataUnit: 'Percent'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 80
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 95
    azureResourceId: monitoredResources.containerApp
    azureResourceKind: 'ContainerApp'
  }
  {
    name: 'iot-web-response-time'
    displayName: 'Web app response time'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'ResponseTime'
    aggregationType: 'Average'
    dataUnit: 'MilliSeconds'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 3000
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 5000
    azureResourceId: monitoredResources.containerApp
    azureResourceKind: 'ContainerApp'
  }
  {
    name: 'iot-web-restarts'
    displayName: 'Web app restarts'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'RestartCount'
    aggregationType: 'Total'
    dataUnit: 'Count'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 0
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 1
    azureResourceId: monitoredResources.containerApp
    azureResourceKind: 'ContainerApp'
  }
  {
    name: 'iot-mcp-cpu'
    displayName: 'MCP server CPU'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'CpuPercentage'
    aggregationType: 'Average'
    dataUnit: 'Percent'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 80
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 95
    azureResourceId: monitoredResources.mcpApp
    azureResourceKind: 'ContainerApp'
  }
  {
    name: 'iot-mcp-memory'
    displayName: 'MCP server memory'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'MemoryPercentage'
    aggregationType: 'Average'
    dataUnit: 'Percent'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 80
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 95
    azureResourceId: monitoredResources.mcpApp
    azureResourceKind: 'ContainerApp'
  }
  {
    name: 'iot-mcp-response-time'
    displayName: 'MCP server response time'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'ResponseTime'
    aggregationType: 'Average'
    dataUnit: 'MilliSeconds'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 7000
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 10000
    azureResourceId: monitoredResources.mcpApp
    azureResourceKind: 'ContainerApp'
  }
  {
    name: 'iot-mcp-restarts'
    displayName: 'MCP server restarts'
    metricNamespace: 'Microsoft.App/containerApps'
    metricName: 'RestartCount'
    aggregationType: 'Total'
    dataUnit: 'Count'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 0
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 1
    azureResourceId: monitoredResources.mcpApp
    azureResourceKind: 'ContainerApp'
  }
  {
    name: 'iot-foundry-client-errors'
    displayName: 'Foundry client errors'
    metricNamespace: 'Microsoft.CognitiveServices/accounts'
    metricName: 'ClientErrors'
    aggregationType: 'Total'
    dataUnit: 'Count'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 2
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 10
    azureResourceId: monitoredResources.foundryAccount
    azureResourceKind: 'CognitiveServicesAccount'
  }
  {
    name: 'iot-foundry-server-errors'
    displayName: 'Foundry server errors'
    metricNamespace: 'Microsoft.CognitiveServices/accounts'
    metricName: 'ServerErrors'
    aggregationType: 'Total'
    dataUnit: 'Count'
    degradedOperator: 'GreaterThan'
    degradedThreshold: 0
    unhealthyOperator: 'GreaterThan'
    unhealthyThreshold: 0
    azureResourceId: monitoredResources.foundryAccount
    azureResourceKind: 'CognitiveServicesAccount'
  }
]

resource definitions 'Microsoft.CloudHealth/healthmodels/signaldefinitions@2026-05-01-preview' = [for profile in profiles: {
  parent: model
  name: profile.name
  properties: {
    displayName: profile.displayName
    signalKind: 'AzureResourceMetric'
    refreshInterval: 'PT5M'
    metricNamespace: profile.metricNamespace
    metricName: profile.metricName
    aggregationType: profile.aggregationType
    dataUnit: profile.dataUnit
    timeGrain: 'PT5M'
    evaluationRules: {
      degradedRule: {
        operator: profile.degradedOperator
        threshold: profile.degradedThreshold
      }
      unhealthyRule: {
        operator: profile.unhealthyOperator
        threshold: profile.unhealthyThreshold
      }
    }
  }
}]

output signalProfiles array = [
  for profile in profiles: {
    signalDefinitionName: profile.name
    displayName: profile.displayName
    authenticationSetting: authenticationSettingName
    azureResourceId: profile.azureResourceId
    azureResourceKind: profile.azureResourceKind
  }
]
