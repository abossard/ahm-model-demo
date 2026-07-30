targetScope = 'resourceGroup'

@description('Region hosting the Azure OpenAI account.')
param aiLocation string

@description('Name of the Azure OpenAI account.')
param aiAccountName string

param aiDeploymentName string = 'gpt-54-mini'
param aiModelName string = 'gpt-5.4-mini'
param aiModelVersion string = '2026-03-17'
param aiDeploymentSkuName string = 'GlobalStandard'
@minValue(1)
param aiDeploymentCapacity int = 10

@description('Resource ID of the workload user-assigned identity.')
param identityId string

@description('Principal ID of the workload user-assigned identity.')
param identityPrincipalId string

@description('Tags applied to all taggable resources.')
param tags object

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
  name: guid(aiAccount.id, identityId, 'Cognitive Services OpenAI User')
  properties: {
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
    )
  }
}

@description('Inference endpoint the identity may now call.')
output azureOpenAIEndpoint string = aiAccount.properties.endpoint

@description('Deployment the identity may now call.')
output azureOpenAIDeploymentName string = aiDeployment.name

