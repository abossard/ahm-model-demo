targetScope = 'resourceGroup'

@description('Region hosting the Foundry account. Hosted agents need a supported region such as swedencentral.')
param location string

@description('Name of the Foundry account. Also its custom subdomain.')
param accountName string

@description('Name of the Foundry project that hosts the agent.')
param projectName string

param modelDeploymentName string = 'gpt-54-mini'
param modelName string = 'gpt-5.4-mini'
param modelVersion string = '2026-03-17'
param modelDeploymentSkuName string = 'GlobalStandard'
@minValue(1)
param modelDeploymentCapacity int = 500

@description('Container registry holding the hosted agent image.')
param registryName string

@description('Resource ID of the workload user-assigned identity.')
param identityId string

@description('Principal ID of the workload user-assigned identity. It calls the hosted agent.')
param identityPrincipalId string

@description('Object ID of the user running azd. It deploys hosted agent versions.')
param deployerPrincipalId string

@description('Host name of the web app. The agent fetches its per-Task token there.')
param webFqdn string

@description('Host name of the MCP server. The agent calls its Azure tools there.')
param mcpFqdn string

@description('Tags applied to all taggable resources.')
param tags object

// Hosts that hosted-agent sessions may call; everything else is denied. Exact hosts only: a wildcard would also match
// other tenants, and Application Insights ingestion with a foreign key needs no authentication. Foundry's required
// platform connectivity is allowed separately. The agent reaches Azure only through the MCP server, which exchanges
// the user's token itself, and the web app, which issues that token, so ARM, Entra and Log Analytics are not listed.
var egressAllowedHosts = [
  '${accountName}.services.ai.azure.com'
  '${accountName}.openai.azure.com'
  '${accountName}.cognitiveservices.azure.com'
  webFqdn
  mcpFqdn
  'github.com'
  'codeload.github.com'
]

// The same content filters as Microsoft.DefaultV2, read from a live account. The service rejects a custom policy without
// an explicit list, and an empty list would pass validation but carry no filters.
var contentFilters = [
  { name: 'Hate', source: 'Prompt', severityThreshold: 'Medium', blocking: true, enabled: true }
  { name: 'Hate', source: 'Completion', severityThreshold: 'Medium', blocking: true, enabled: true }
  { name: 'Sexual', source: 'Prompt', severityThreshold: 'Medium', blocking: true, enabled: true }
  { name: 'Sexual', source: 'Completion', severityThreshold: 'Medium', blocking: true, enabled: true }
  { name: 'Violence', source: 'Prompt', severityThreshold: 'Medium', blocking: true, enabled: true }
  { name: 'Violence', source: 'Completion', severityThreshold: 'Medium', blocking: true, enabled: true }
  { name: 'Selfharm', source: 'Prompt', severityThreshold: 'Medium', blocking: true, enabled: true }
  { name: 'Selfharm', source: 'Completion', severityThreshold: 'Medium', blocking: true, enabled: true }
  { name: 'Jailbreak', source: 'Prompt', blocking: true, enabled: true }
  { name: 'Protected Material Text', source: 'Completion', blocking: true, enabled: true }
  { name: 'Protected Material Code', source: 'Completion', blocking: false, enabled: true }
]

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

resource account 'Microsoft.CognitiveServices/accounts@2026-03-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowProjectManagement: true
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2026-03-01' = {
  parent: account
  name: modelDeploymentName
  sku: {
    name: modelDeploymentSkuName
    capacity: modelDeploymentCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2026-03-01' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: projectName
    description: 'Hosts the health model task agent.'
  }
  // The account accepts one child operation at a time.
  dependsOn: [
    modelDeployment
  ]
}

// Attached per agent version through definition.rai_config.rai_policy_name.
// egressPolicy exists only in preview API versions.
resource agentEgressPolicy 'Microsoft.CognitiveServices/accounts/raiPolicies@2026-05-15-preview' = {
  parent: account
  name: 'agent-egress'
  properties: {
    mode: 'Blocking'
    basePolicyName: 'Microsoft.DefaultV2'
    contentFilters: contentFilters
    egressPolicy: {
      mode: 'Enforced'
      defaultAction: 'Deny'
      rules: [
        for (host, index) in egressAllowedHosts: {
          name: 'allow-${index}'
          ruleType: 'Fqdn'
          match: {
            host: host
          }
          action: {
            actionType: 'Allow'
          }
        }
      ]
    }
  }
  dependsOn: [
    project
  ]
}

// Infrastructure identity of the project; hosted-agent code runs under its own agent identity.
resource projectFoundryUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, project.id, 'Foundry User')
  properties: {
    principalId: project.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '53ca6127-db72-4b80-b1b0-d745d6d5456d'
    )
  }
}

// The platform pulls the agent image with the project identity. The registry keeps the legacy permissions mode,
// where AcrPull is the pull role; Container Registry Repository Reader is its counterpart for ABAC mode.
resource projectAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, project.id, 'AcrPull')
  properties: {
    principalId: project.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

resource appAgentConsumer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: project
  name: guid(project.id, identityId, 'Foundry Agent Consumer')
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'eed3b665-ab3a-47b6-8f48-c9382fb1dad6'
    )
  }
}

resource deployerProjectManager 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: project
  name: guid(project.id, deployerPrincipalId, 'Foundry Project Manager')
  properties: {
    principalId: deployerPrincipalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'eadc314b-1a2d-4efa-be10-5d325db5065e'
    )
  }
}

@description('Account the health model reads inference signals from.')
output accountId string = account.id

output accountName string = account.name

@description('Project the health model binds the hosted agent to.')
output projectId string = project.id

output projectName string = project.name

@description('Endpoint for agent deployment, sessions and responses.')
output projectEndpoint string = 'https://${accountName}.services.ai.azure.com/api/projects/${project.name}'

output modelDeploymentName string = modelDeployment.name

@description('Full ID that each hosted agent version references as its RAI policy.')
output agentEgressPolicyId string = agentEgressPolicy.id
