targetScope = 'resourceGroup'

@description('Primary Azure region for the demo workload.')
param location string

@description('Suffix that makes the storage account name globally unique.')
param resourceToken string

@description('Log Analytics workspace receiving the queue diagnostic stream.')
param workspaceId string

@description('Tags applied to all taggable resources.')
param tags object

var queueName = 'requests'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stahm${resourceToken}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: []
    }
  }
}

resource requestQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: queueName
  properties: {
    metadata: {
      purpose: 'azure-health-model-movie-demo'
    }
  }
}

resource queueDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: queueService
  name: 'diag-queue-to-law'
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

output storageId string = storage.id
output storageName string = storage.name
output queueName string = requestQueue.name
