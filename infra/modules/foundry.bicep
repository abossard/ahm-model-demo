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
param modelDeploymentCapacity int = 10

@description('Hosts that hosted-agent sessions may call. Everything else is denied.')
param egressAllowedHosts array = [
  split(environment().resourceManager, '/')[2]
  split(environment().authentication.loginEndpoint, '/')[2]
  'api.loganalytics.io'
  '*.services.ai.azure.com'
  '*.openai.azure.com'
  '*.cognitiveservices.azure.com'
  '*.in.applicationinsights.azure.com'
  'github.com'
  'codeload.github.com'
]

@description('Resource ID of the workload user-assigned identity.')
param identityId string

@description('Principal ID of the workload user-assigned identity. It calls the hosted agent.')
param identityPrincipalId string

@description('Object ID of the user running azd. It deploys hosted agent versions.')
param deployerPrincipalId string

@description('Tags applied to all taggable resources.')
param tags object

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

// Kept until the chat copilot in src/agent-app is removed.
resource appInference 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, identityId, 'Cognitive Services OpenAI User')
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
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

output projectName string = project.name

@description('Endpoint for agent deployment, sessions and responses.')
output projectEndpoint string = 'https://${accountName}.services.ai.azure.com/api/projects/${project.name}'

@description('OpenAI-compatible endpoint the chat copilot calls until it is removed.')
output openAiEndpoint string = account.properties.endpoints['OpenAI Language Model Instance API']

output modelDeploymentName string = modelDeployment.name

@description('Full ID that each hosted agent version references as its RAI policy.')
output agentEgressPolicyId string = agentEgressPolicy.id
