targetScope = 'subscription'

@minLength(1)
@maxLength(20)
@description('Name of the azd environment. Seeds the resource group and every resource name.')
param environmentName string

@minLength(1)
@description('Primary Azure region for the demo workload.')
param location string

@description('Object ID of the principal running the deployment. Becomes the PostgreSQL Entra administrator.')
param principalId string

@description('UPN of the principal running the deployment.')
param adminUpn string

@description('Single IPv4 address allowed to reach PostgreSQL for the postprovision bootstrap.')
param adminIpAddress string

@description('Region hosting the Azure Health Model.')
param healthModelLocation string = location

@description('Region hosting the Azure OpenAI account backing the copilot.')
param openAiLocation string = 'swedencentral'

@minValue(1)
@description('Tokens-per-minute capacity of the Azure OpenAI deployment, in thousands.')
param openAiDeploymentCapacity int = 10

@description('Image published by "azd deploy web". Empty until the first deploy.')
param webImage string = ''

@description('Image published by "azd deploy agent-web". Empty until the first deploy.')
param agentWebImage string = ''

@description('Image published by "azd deploy agent-app". Empty until the first deploy.')
param agentAppImage string = ''

@description('Filming-only availability test that writes through the full request journey.')
param journeyAvailabilityTestEnabled bool = false

var tags = {
  'azd-env-name': environmentName
  workload: 'azure-health-model-demo'
}
var resourceToken = uniqueString(subscription().id, environmentName)
var namePrefix = environmentName
var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
var webAppName = 'ca-${namePrefix}-web'
var agentWebAppName = 'ca-${namePrefix}-agent-web'
var agentAppName = 'ca-${namePrefix}-agent-app'
var healthModelName = 'hm-${namePrefix}'

resource rg 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module foundation 'modules/foundation.bicep' = {
  scope: rg
  name: 'foundation'
  params: {
    location: location
    resourceToken: resourceToken
    namePrefix: namePrefix
    adminObjectId: principalId
    adminUpn: adminUpn
    adminIpAddress: adminIpAddress
    tags: tags
  }
}

module storage 'modules/storage.bicep' = {
  scope: rg
  name: 'storage'
  params: {
    location: location
    resourceToken: resourceToken
    workspaceId: foundation.outputs.workspaceId
    tags: tags
  }
}

module queuePrivateEndpoint 'modules/queue-private-endpoint.bicep' = {
  scope: rg
  name: 'queue-private-endpoint'
  params: {
    location: location
    namePrefix: namePrefix
    storageId: storage.outputs.storageId
    subnetId: foundation.outputs.privateEndpointSubnetId
    privateDnsZoneId: foundation.outputs.queuePrivateDnsZoneId
    tags: tags
  }
}

module subscriptionMonitoring 'modules/subscription-monitoring.bicep' = {
  name: 'subscription-monitoring'
  params: {
    diagnosticSettingName: 'diag-${namePrefix}-activity'
    logAnalyticsWorkspaceId: foundation.outputs.workspaceId
    taskResourceGroupId: rg.id
    environmentName: environmentName
  }
}

module copilot 'modules/copilot.bicep' = {
  scope: rg
  name: 'copilot'
  params: {
    aiLocation: openAiLocation
    aiAccountName: 'oai-${namePrefix}-${resourceToken}'
    aiDeploymentCapacity: openAiDeploymentCapacity
    identityId: foundation.outputs.identityId
    identityPrincipalId: foundation.outputs.identityPrincipalId
    tags: tags
  }
}

module rbac 'modules/rbac.bicep' = {
  scope: rg
  name: 'rbac'
  params: {
    registryName: foundation.outputs.registryName
    storageName: storage.outputs.storageName
    queueName: storage.outputs.queueName
    applicationInsightsName: foundation.outputs.applicationInsightsName
    identityId: foundation.outputs.identityId
    identityPrincipalId: foundation.outputs.identityPrincipalId
  }
}

module aks 'modules/aks.bicep' = {
  scope: rg
  name: 'aks'
  params: {
    location: location
    namePrefix: namePrefix
    aksSubnetId: foundation.outputs.aksSubnetId
    tags: tags
  }
}

module aksAccess 'modules/aks-access.bicep' = {
  scope: rg
  name: 'aks-access'
  params: {
    registryName: foundation.outputs.registryName
    kubeletObjectId: aks.outputs.kubeletObjectId
    identityName: foundation.outputs.identityName
    oidcIssuerUrl: aks.outputs.oidcIssuerUrl
    namePrefix: namePrefix
  }
}

var containerEnvironmentDomain = foundation.outputs.environmentDefaultDomain
var agentWebOrigin = 'https://${agentWebAppName}.internal.${containerEnvironmentDomain}'
var agentAppUrl = 'https://${agentAppName}.internal.${containerEnvironmentDomain}/'
var webUrl = 'https://${webAppName}.${containerEnvironmentDomain}/'

module web 'modules/container-app.bicep' = {
  scope: rg
  name: 'container-app-web'
  params: {
    name: webAppName
    location: location
    serviceName: 'web'
    environmentId: foundation.outputs.environmentId
    identityId: foundation.outputs.identityId
    registryLoginServer: rbac.outputs.registryLoginServer
    image: webImage
    placeholderImage: placeholderImage
    targetPort: 8080
    external: true
    cpu: '0.5'
    memory: '1Gi'
    tags: tags
    env: [
      {
        name: 'AZURE_CLIENT_ID'
        value: foundation.outputs.identityClientId
      }
      {
        name: 'QUEUE_URL'
        value: rbac.outputs.queueUrl
      }
      {
        name: 'POSTGRES_HOST'
        value: foundation.outputs.postgresHost
      }
      {
        name: 'POSTGRES_DATABASE'
        value: foundation.outputs.postgresDatabase
      }
      {
        name: 'POSTGRES_USER'
        value: foundation.outputs.identityName
      }
      {
        name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
        value: rbac.outputs.applicationInsightsConnectionString
      }
      {
        name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING'
        value: 'Authorization=AAD;ClientId=${foundation.outputs.identityClientId}'
      }
      {
        name: 'OTEL_SERVICE_NAME'
        value: environmentName
      }
      {
        name: 'AZURE_SUBSCRIPTION_ID'
        value: subscription().subscriptionId
      }
      {
        name: 'AZURE_SUBSCRIPTION_NAME'
        value: subscription().displayName
      }
      {
        name: 'AZURE_RESOURCE_GROUP'
        value: rg.name
      }
      {
        name: 'HEALTH_MODEL_NAME'
        value: healthModelName
      }
      {
        name: 'HEALTH_MODEL_LOCATION'
        value: healthModelLocation
      }
      {
        name: 'EXPECTED_SUBSCRIPTION_ID'
        value: subscription().subscriptionId
      }
      {
        name: 'EXPECTED_SUBSCRIPTION_NAME'
        value: subscription().displayName
      }
      {
        name: 'EXPECTED_RESOURCE_GROUP'
        value: rg.name
      }
      {
        name: 'EXPECTED_MODEL_NAME'
        value: healthModelName
      }
      {
        name: 'EXPECTED_MODEL_LOCATION'
        value: healthModelLocation
      }
      {
        name: 'HEALTH_COPILOT_ENABLED'
        value: 'true'
      }
      {
        name: 'AGENT_WEB_ORIGIN'
        value: agentWebOrigin
      }
    ]
  }
}

module agentWeb 'modules/container-app.bicep' = {
  scope: rg
  name: 'container-app-agent-web'
  params: {
    name: agentWebAppName
    location: location
    serviceName: 'agent-web'
    environmentId: foundation.outputs.environmentId
    identityId: foundation.outputs.identityId
    registryLoginServer: rbac.outputs.registryLoginServer
    image: agentWebImage
    placeholderImage: placeholderImage
    targetPort: 3000
    external: false
    cpu: '0.5'
    memory: '1Gi'
    tags: tags
    env: [
      {
        name: 'AGENT_URL'
        value: agentAppUrl
      }
      {
        name: 'COPILOTKIT_TELEMETRY_DISABLED'
        value: 'true'
      }
    ]
  }
}

module agentApp 'modules/container-app.bicep' = {
  scope: rg
  name: 'container-app-agent-app'
  params: {
    name: agentAppName
    location: location
    serviceName: 'agent-app'
    environmentId: foundation.outputs.environmentId
    identityId: foundation.outputs.identityId
    registryLoginServer: rbac.outputs.registryLoginServer
    image: agentAppImage
    placeholderImage: placeholderImage
    targetPort: 8000
    external: false
    cpu: '0.5'
    memory: '1Gi'
    tags: tags
    env: [
      {
        name: 'AZURE_CLIENT_ID'
        value: foundation.outputs.identityClientId
      }
      {
        name: 'AZURE_OPENAI_ENDPOINT'
        value: copilot.outputs.azureOpenAIEndpoint
      }
      {
        name: 'AZURE_OPENAI_CHAT_DEPLOYMENT_NAME'
        value: copilot.outputs.azureOpenAIDeploymentName
      }
      {
        name: 'HEALTH_APP_BASE_URL'
        value: webUrl
      }
      {
        name: 'HEALTH_API_TIMEOUT_SECONDS'
        value: '8'
      }
      {
        name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
        value: rbac.outputs.applicationInsightsConnectionString
      }
      {
        name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING'
        value: 'Authorization=AAD;ClientId=${foundation.outputs.identityClientId}'
      }
      {
        name: 'OTEL_SERVICE_NAME'
        value: 'ahm-health-copilot'
      }
    ]
  }
}

module availabilityTests 'modules/availability-tests.bicep' = {
  scope: rg
  name: 'availability-tests'
  params: {
    location: location
    namePrefix: namePrefix
    applicationInsightsName: foundation.outputs.applicationInsightsName
    appUrl: 'https://${web.outputs.fqdn}/'
    journeyAvailabilityTestEnabled: journeyAvailabilityTestEnabled
    tags: tags
  }
}

module healthModel 'modules/health-model.bicep' = {
  scope: rg
  name: 'health-model'
  params: {
    modelName: healthModelName
    healthModelLocation: healthModelLocation
    namePrefix: namePrefix
    appIdentityPrincipalId: foundation.outputs.identityPrincipalId
    healthReportRoleDefinitionId: subscriptionMonitoring.outputs.healthReportRoleDefinitionId
    tags: tags
  }
}

module healthModelAccess 'modules/health-model-access.bicep' = {
  scope: rg
  name: 'health-model-access'
  params: {
    modelPrincipalId: healthModel.outputs.modelPrincipalId
    monitoredResources: {
      containerApp: web.outputs.containerAppId
      postgres: foundation.outputs.postgresId
      storage: storage.outputs.storageId
      logAnalyticsWorkspace: foundation.outputs.workspaceId
      applicationInsights: foundation.outputs.applicationInsightsId
    }
  }
}

module healthModelEntities 'modules/health-model-entities.bicep' = {
  scope: rg
  name: 'health-model-entities'
  params: {
    modelName: healthModel.outputs.modelName
    authenticationSettingName: healthModel.outputs.authenticationSettingName
    rootActionGroupId: healthModel.outputs.rootActionGroupId
    monitoredResources: healthModelAccess.outputs.monitoredResources
    availabilityTestName: availabilityTests.outputs.availabilityTestName
  }
}

module healthModelRelationships 'modules/health-model-relationships.bicep' = {
  scope: rg
  name: 'health-model-relationships'
  params: {
    modelName: healthModel.outputs.modelName
    entityNames: healthModelEntities.outputs.entityNames
    discoverySourceId: healthModelAccess.outputs.monitoredResources.applicationInsights
  }
}

module healthModelDiscovery 'modules/health-model-discovery.bicep' = {
  scope: rg
  name: 'health-model-discovery'
  params: {
    modelName: healthModel.outputs.modelName
    authenticationSettingName: healthModel.outputs.authenticationSettingName
    discoverySourceId: healthModelRelationships.outputs.discoverySourceId
  }
}

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = aksAccess.outputs.registryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = foundation.outputs.registryName
output AZURE_CONTAINER_APPS_ENVIRONMENT_ID string = foundation.outputs.environmentId
output AZURE_AKS_CLUSTER_NAME string = aks.outputs.clusterName
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_IDENTITY_NAME string = foundation.outputs.identityName
output AZURE_IDENTITY_CLIENT_ID string = foundation.outputs.identityClientId
output AZURE_IDENTITY_PRINCIPAL_ID string = foundation.outputs.identityPrincipalId
output AZURE_QUEUE_URL string = rbac.outputs.queueUrl
output AZURE_POSTGRES_HOST string = foundation.outputs.postgresHost
output AZURE_POSTGRES_DATABASE string = foundation.outputs.postgresDatabase
output AZURE_SUBSCRIPTION_ID string = subscription().subscriptionId
output AZURE_SUBSCRIPTION_NAME string = subscription().displayName
output APPLICATIONINSIGHTS_CONNECTION_STRING string = rbac.outputs.applicationInsightsConnectionString
output AZURE_OPENAI_ENDPOINT string = copilot.outputs.azureOpenAIEndpoint
output AZURE_OPENAI_CHAT_DEPLOYMENT_NAME string = copilot.outputs.azureOpenAIDeploymentName
output AZURE_HEALTH_MODEL_NAME string = healthModel.outputs.modelName
output HEALTH_MODEL_LOCATION string = healthModelLocation
output SERVICE_WEB_NAME string = web.outputs.containerAppName
output SERVICE_WEB_FQDN string = web.outputs.fqdn
output SERVICE_WEB_ID string = web.outputs.containerAppId
output SERVICE_AGENT_WEB_NAME string = agentWeb.outputs.containerAppName
output SERVICE_AGENT_APP_NAME string = agentApp.outputs.containerAppName
output HEALTH_MODEL_ID string = healthModel.outputs.modelId
output HEALTH_MODEL_NAME string = healthModel.outputs.modelName
output HEALTH_MODEL_ENTITY_COUNT int = healthModelEntities.outputs.deterministicEntityCount
output HEALTH_MODEL_RELATIONSHIP_COUNT int = healthModelRelationships.outputs.deterministicRelationshipCount
output HEALTH_MODEL_DISCOVERY_RULE_ID string = healthModelDiscovery.outputs.discoveryRuleId
output AVAILABILITY_TEST_NAME string = availabilityTests.outputs.availabilityTestName
output AVAILABILITY_TEST_URL string = availabilityTests.outputs.availabilityTestUrl
