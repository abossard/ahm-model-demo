targetScope = 'resourceGroup'

@description('Container registry the workload identity pulls images from.')
param registryName string

@description('Storage account owning the request queue.')
param storageName string

@description('Queue the workload identity enqueues request events into.')
param queueName string

@description('Application Insights component the workload identity publishes telemetry to.')
param applicationInsightsName string

@description('Resource ID of the workload user-assigned identity.')
param identityId string

@description('Principal ID of the workload user-assigned identity.')
param identityPrincipalId string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' existing = {
  parent: queueService
  name: queueName
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

resource queueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: queue
  name: guid(queue.id, identityId, 'Storage Queue Data Contributor')
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
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

@description('Queue the identity may now write to.')
output queueUrl string = 'https://${storage.name}.queue.${environment().suffixes.storage}/${queueName}'

@description('Application Insights endpoint the identity may now publish to.')
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString
