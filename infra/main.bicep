targetScope = 'subscription'

@minLength(1)
@maxLength(20)
@description('Name of the azd environment. Seeds the resource group and every resource name.')
param environmentName string

@minLength(1)
@description('Region of every resource. Use swedencentral: Foundry hosted agents are not available in northeurope.')
param location string

@description('Object ID of the principal running the deployment. Becomes Foundry Project Manager on the project.')
param principalId string

@description('Region hosting the Azure Health Models.')
param healthModelLocation string = location

@minValue(1)
@description('Tokens-per-minute capacity of the model deployment, in thousands.')
param modelDeploymentCapacity int = 500

@description('Image published by "azd deploy web". Empty until the first deploy.')
param webImage string = ''

@description('Let the Azure CLI request tokens for the web API without a browser sign-in of the app, for unattended checks as a signed-in developer. Any user in the tenant can then script the API as themselves, so it stays off by default. The MCP scope is never opened to it.')
param entraAllowAzureCli bool = false

@description('Directory (tenant) ids, separated by commas, whose users may sign in to the web app. Empty lets every Microsoft Entra directory in, and the directory this app belongs to is always allowed. A personal Microsoft account signs in through a directory it belongs to, so it is let in by that directory\'s id.')
param entraAllowedTenants string = ''

@description('Image published by "azd deploy mcp". Empty until the first deploy.')
param mcpImage string = ''

@description('Object ID of the hosted agent identity. Empty until the agent exists: the agent deploy script sets it as an azd environment value, and the web app uses it to recognise the agent\'s token requests.')
param foundryAgentPrincipalId string = ''

var tags = {
  'azd-env-name': environmentName
  workload: 'azure-health-model-demo'
}
var resourceToken = uniqueString(subscription().id, environmentName)
var namePrefix = environmentName
var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
var webAppName = 'ca-${namePrefix}-web'
var mcpAppName = 'ca-${namePrefix}-mcp'
var healthModelName = 'hm-${namePrefix}'
var designHealthModelName = 'hm-${namePrefix}-design'
var foundryAgentName = 'health-model-agent'

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
    tags: tags
  }
}

// A Container App named N is reachable at N.<environment default domain>, so both URLs are known before the apps exist.
// The Entra redirect URI and the agent egress allow-list need them, and the apps need the Entra client ids.
var webFqdn = '${webAppName}.${foundation.outputs.environmentDefaultDomain}'
var mcpFqdn = '${mcpAppName}.${foundation.outputs.environmentDefaultDomain}'

module storage 'modules/storage.bicep' = {
  scope: rg
  name: 'storage'
  params: {
    location: location
    resourceToken: resourceToken
    namePrefix: namePrefix
    vnetId: foundation.outputs.vnetId
    privateEndpointSubnetId: foundation.outputs.privateEndpointSubnetId
    workspaceId: foundation.outputs.workspaceId
    tags: tags
  }
}

module subscriptionMonitoring 'modules/subscription-monitoring.bicep' = {
  name: 'subscription-monitoring-${deployment().location}'
  params: {
    diagnosticSettingName: 'diag-${namePrefix}-activity'
    logAnalyticsWorkspaceId: foundation.outputs.workspaceId
  }
}

module foundry 'modules/foundry.bicep' = {
  scope: rg
  name: 'foundry'
  params: {
    location: location
    accountName: 'aif-${namePrefix}-${resourceToken}'
    projectName: 'proj-${namePrefix}'
    modelDeploymentCapacity: modelDeploymentCapacity
    registryName: foundation.outputs.registryName
    identityId: foundation.outputs.identityId
    identityPrincipalId: foundation.outputs.identityPrincipalId
    deployerPrincipalId: principalId
    webFqdn: webFqdn
    mcpFqdn: mcpFqdn
    tags: tags
  }
}

module entra 'modules/entra.bicep' = {
  scope: rg
  name: 'entra'
  params: {
    environmentName: environmentName
    webUrl: 'https://${webFqdn}/'
    identityPrincipalId: foundation.outputs.identityPrincipalId
    allowAzureCli: entraAllowAzureCli
  }
}

module rbac 'modules/rbac.bicep' = {
  scope: rg
  name: 'rbac'
  params: {
    registryName: foundation.outputs.registryName
    storageName: storage.outputs.storageName
    sessionsContainerName: storage.outputs.sessionsContainerName
    applicationInsightsName: foundation.outputs.applicationInsightsName
    identityId: foundation.outputs.identityId
    identityPrincipalId: foundation.outputs.identityPrincipalId
  }
}

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
        name: 'HEALTH_MODEL_DESIGN_NAME'
        value: designHealthModelName
      }
      {
        name: 'SESSIONS_CONTAINER_URL'
        value: rbac.outputs.sessionsContainerUrl
      }
      {
        name: 'FOUNDRY_PROJECT_ENDPOINT'
        value: foundry.outputs.projectEndpoint
      }
      {
        name: 'FOUNDRY_AGENT_NAME'
        value: foundryAgentName
      }
      {
        name: 'FOUNDRY_AGENT_PRINCIPAL_ID'
        value: foundryAgentPrincipalId
      }
      {
        name: 'ENTRA_TENANT_ID'
        value: entra.outputs.tenantId
      }
      {
        name: 'ENTRA_ALLOWED_TENANTS'
        value: entraAllowedTenants
      }
      {
        name: 'ENTRA_CLIENT_ID'
        value: entra.outputs.webClientId
      }
      {
        name: 'ENTRA_API_SCOPE'
        value: entra.outputs.webApiScope
      }
      {
        name: 'MCP_SCOPE'
        value: entra.outputs.mcpScope
      }
      {
        name: 'MCP_URL'
        value: 'https://${mcpFqdn}/'
      }
    ]
  }
}

// The Azure tools of the agent. It exchanges each caller's token for ARM and Log Analytics tokens itself (on behalf
// of the user), so it needs no Azure role. External ingress because the hosted agent calls it from Foundry's network.
// The flags that make it read-only and pick its tools live in src/mcp/Dockerfile.
module mcp 'modules/container-app.bicep' = {
  scope: rg
  name: 'container-app-mcp'
  params: {
    name: mcpAppName
    location: location
    serviceName: 'mcp'
    environmentId: foundation.outputs.environmentId
    identityId: foundation.outputs.identityId
    registryLoginServer: rbac.outputs.registryLoginServer
    image: mcpImage
    placeholderImage: placeholderImage
    targetPort: 8080
    external: true
    cpu: '0.5'
    memory: '1Gi'
    tags: tags
    env: [
      {
        name: 'AzureAd__Instance'
        value: environment().authentication.loginEndpoint
      }
      // Users of any directory call this server. Its token validation reads the directory from each token, and the
      // exchange for ARM and Log Analytics runs in that directory.
      {
        name: 'AzureAd__TenantId'
        value: 'organizations'
      }
      {
        name: 'AzureAd__ClientId'
        value: entra.outputs.mcpClientId
      }
      {
        name: 'AzureAd__ClientCredentials__0__SourceType'
        value: 'SignedAssertionFromManagedIdentity'
      }
      {
        name: 'AzureAd__ClientCredentials__0__ManagedIdentityClientId'
        value: foundation.outputs.identityClientId
      }
      {
        name: 'AzureAd__ClientCredentials__0__TokenExchangeUrl'
        value: 'api://AzureADTokenExchange'
      }
      // The ingress terminates TLS and forwards plain HTTP, so redirecting to HTTPS would loop, and the server reads
      // the original scheme from X-Forwarded-Proto for its OAuth metadata.
      {
        name: 'AZURE_MCP_DANGEROUSLY_DISABLE_HTTPS_REDIRECTION'
        value: 'true'
      }
      {
        name: 'AZURE_MCP_DANGEROUSLY_ENABLE_FORWARDED_HEADERS'
        value: 'true'
      }
      // Its telemetry exporter has no credential and Application Insights here accepts only Entra tokens. Off also
      // keeps product telemetry from leaving the deployment.
      {
        name: 'AZURE_MCP_COLLECT_TELEMETRY'
        value: 'false'
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
    mcpHealthUrl: 'https://${mcp.outputs.fqdn}/health'
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
      mcpApp: mcp.outputs.containerAppId
      foundryProject: foundry.outputs.projectId
      foundryAccount: foundry.outputs.accountId
      sessionsBlobService: storage.outputs.blobServiceId
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
    mcpAvailabilityTestName: availabilityTests.outputs.mcpAvailabilityTestName
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

module designHealthModel 'modules/design-health-model.bicep' = {
  scope: rg
  name: 'design-health-model'
  params: {
    modelName: designHealthModelName
    healthModelLocation: healthModelLocation
    tags: tags
  }
}

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = rbac.outputs.registryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = foundation.outputs.registryName
output AZURE_CONTAINER_APPS_ENVIRONMENT_ID string = foundation.outputs.environmentId
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_SUBSCRIPTION_ID string = subscription().subscriptionId
output AZURE_SUBSCRIPTION_NAME string = subscription().displayName
output APPLICATIONINSIGHTS_CONNECTION_STRING string = rbac.outputs.applicationInsightsConnectionString
output SESSIONS_CONTAINER_URL string = rbac.outputs.sessionsContainerUrl
output FOUNDRY_ACCOUNT_NAME string = foundry.outputs.accountName
output FOUNDRY_PROJECT_NAME string = foundry.outputs.projectName
output FOUNDRY_PROJECT_ENDPOINT string = foundry.outputs.projectEndpoint
output FOUNDRY_MODEL_DEPLOYMENT_NAME string = foundry.outputs.modelDeploymentName
output FOUNDRY_AGENT_EGRESS_POLICY_ID string = foundry.outputs.agentEgressPolicyId
output FOUNDRY_AGENT_NAME string = foundryAgentName
output HEALTH_MODEL_NAME string = healthModel.outputs.modelName
output HEALTH_MODEL_LOCATION string = healthModelLocation
output HEALTH_MODEL_DESIGN_NAME string = designHealthModel.outputs.modelName
output HEALTH_MODEL_ENTITY_COUNT int = healthModelEntities.outputs.deterministicEntityCount
output HEALTH_MODEL_RELATIONSHIP_COUNT int = healthModelRelationships.outputs.deterministicRelationshipCount
output HEALTH_MODEL_DISCOVERY_RULE_ID string = healthModelDiscovery.outputs.discoveryRuleId
output SERVICE_WEB_FQDN string = web.outputs.fqdn
output SERVICE_WEB_NAME string = web.outputs.containerAppName
output SERVICE_MCP_FQDN string = mcp.outputs.fqdn
output ENTRA_TENANT_ID string = entra.outputs.tenantId
output ENTRA_CLIENT_ID string = entra.outputs.webClientId
output ENTRA_API_SCOPE string = entra.outputs.webApiScope
output ENTRA_MCP_CLIENT_ID string = entra.outputs.mcpClientId
output MCP_SCOPE string = entra.outputs.mcpScope
output MCP_URL string = 'https://${mcp.outputs.fqdn}/'
output FOUNDRY_AGENT_PRINCIPAL_ID string = foundryAgentPrincipalId
