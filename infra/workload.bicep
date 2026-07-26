targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentId string
param identityName string = 'id-ahm-demo-app'
param registryName string
param registryLoginServer string
param image string
param storageName string
param queueName string = 'requests'
param postgresHost string
param postgresDatabase string = 'demo'
param applicationInsightsName string = 'appi-ahm-movie-demo'
param applicationInsightsConnectionString string
param azureSubscriptionId string
param azureSubscriptionName string
param healthModelResourceGroup string
param healthModelName string
param healthModelLocation string
param copilotUrl string = ''
param tags object

var copilotEnvironment = empty(copilotUrl) ? [] : [
  {
    name: 'COPILOT_URL'
    value: copilotUrl
  }
]

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
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

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, 'AcrPull')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

resource queueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: queue
  name: guid(queue.id, identity.id, 'Storage Queue Data Contributor')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
    )
  }
}

resource metricsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: applicationInsights
  name: guid(applicationInsights.id, identity.id, 'Monitoring Metrics Publisher')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '3913510d-42f4-4e42-8a64-420c390055eb'
    )
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'app-ahm-movie-demo'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registryLoginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          env: concat([
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'QUEUE_URL'
              value: 'https://${storage.name}.queue.${environment().suffixes.storage}/${queueName}'
            }
            {
              name: 'POSTGRES_HOST'
              value: postgresHost
            }
            {
              name: 'POSTGRES_DATABASE'
              value: postgresDatabase
            }
            {
              name: 'POSTGRES_USER'
              value: identity.name
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: applicationInsightsConnectionString
            }
            {
              name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING'
              value: 'Authorization=AAD;ClientId=${identity.properties.clientId}'
            }
            {
              name: 'OTEL_SERVICE_NAME'
              value: 'ahm-movie-demo'
            }
            {
              name: 'AZURE_SUBSCRIPTION_ID'
              value: azureSubscriptionId
            }
            {
              name: 'AZURE_SUBSCRIPTION_NAME'
              value: azureSubscriptionName
            }
            {
              name: 'AZURE_RESOURCE_GROUP'
              value: healthModelResourceGroup
            }
            {
              name: 'HEALTH_MODEL_NAME'
              value: healthModelName
            }
            {
              name: 'HEALTH_MODEL_LOCATION'
              value: healthModelLocation
            }
          ], copilotEnvironment)
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    acrPull
    queueContributor
    metricsPublisher
  ]
}

output containerAppId string = containerApp.id
output containerAppName string = containerApp.name
output fqdn string = containerApp.properties.configuration.ingress.fqdn
