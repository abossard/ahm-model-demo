targetScope = 'resourceGroup'

@description('Container registry the workload identity pulls images from.')
param registryName string

@description('Storage account owning the session store.')
param storageName string

@description('Blob container the workload identity reads and writes Sessions in.')
param sessionsContainerName string

@description('Application Insights component the workload identity publishes telemetry to.')
param applicationInsightsName string

@description('Resource ID of the workload user-assigned identity.')
param identityId string

@description('Principal ID of the workload user-assigned identity.')
param identityPrincipalId string

@description('Resource ID of the MCP server user-assigned identity.')
param mcpIdentityId string

@description('Principal ID of the MCP server user-assigned identity. It only pulls its image.')
param mcpIdentityPrincipalId string

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource sessionsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: sessionsContainerName
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identityId, 'AcrPull')
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

resource mcpAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, mcpIdentityId, 'AcrPull')
  properties: {
    principalId: mcpIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

resource sessionsContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sessionsContainer
  name: guid(sessionsContainer.id, identityId, 'Storage Blob Data Contributor')
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
    )
  }
}

resource metricsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: applicationInsights
  name: guid(applicationInsights.id, identityId, 'Monitoring Metrics Publisher')
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '3913510d-42f4-4e42-8a64-420c390055eb'
    )
  }
}

@description('Registry the identity may now pull from.')
output registryLoginServer string = registry.properties.loginServer

@description('Session container the identity may now read and write.')
output sessionsContainerUrl string = 'https://${storage.name}.blob.${environment().suffixes.storage}/${sessionsContainer.name}'

@description('Application Insights endpoint the identity may now publish to.')
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString
