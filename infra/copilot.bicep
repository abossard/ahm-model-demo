targetScope = 'resourceGroup'

param aiLocation string = 'swedencentral'
param aiAccountName string = 'oai-ahm-movie-demo'
param aiDeploymentName string = 'gpt-54-mini'
param aiModelName string = 'gpt-5.4-mini'
param aiModelVersion string = '2026-03-17'
param aiDeploymentSkuName string = 'GlobalStandard'
@minValue(1)
param aiDeploymentCapacity int = 10
param environmentId string
param identityName string = 'id-ahm-demo-app'
param registryName string
param registryLoginServer string
param webImage string
param agentImage string
param healthAppUrl string
param applicationInsightsName string = 'appi-ahm-movie-demo'
param applicationInsightsConnectionString string
param tags object

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

resource aiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aiAccountName
  location: aiLocation
  tags: tags
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: aiAccountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource aiDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiAccount
  name: aiDeploymentName
  sku: {
    name: aiDeploymentSkuName
    capacity: aiDeploymentCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: aiModelName
      version: aiModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource inferenceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: aiAccount
  name: guid(aiAccount.id, identity.id, 'Cognitive Services OpenAI User')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
    )
  }
}

resource copilotApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'app-ahm-health-copilot'
  location: resourceGroup().location
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
        targetPort: 3000
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
          image: webImage
          env: [
            {
              name: 'AGENT_URL'
              value: 'http://127.0.0.1:8000/'
            }
            {
              name: 'COPILOTKIT_TELEMETRY_DISABLED'
              value: 'true'
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
        {
          name: 'agent'
          image: agentImage
          env: [
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'AZURE_OPENAI_ENDPOINT'
              value: aiAccount.properties.endpoint
            }
            {
              name: 'AZURE_OPENAI_CHAT_DEPLOYMENT_NAME'
              value: aiDeployment.name
            }
            {
              name: 'HEALTH_APP_BASE_URL'
              value: healthAppUrl
            }
            {
              name: 'HEALTH_API_TIMEOUT_SECONDS'
              value: '8'
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
              value: 'ahm-health-copilot'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
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
    inferenceRole
    applicationInsights
  ]
}

output azureOpenAIEndpoint string = aiAccount.properties.endpoint
output copilotFqdn string = copilotApp.properties.configuration.ingress.fqdn
