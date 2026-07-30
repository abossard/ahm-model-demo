targetScope = 'resourceGroup'

@description('Name of the Azure Health Model.')
param modelName string

@description('Region hosting the Azure Health Model.')
param healthModelLocation string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Principal ID of the workload identity that submits entity health reports.')
param appIdentityPrincipalId string

@description('Custom role definition granting bounded health-report ingestion.')
param healthReportRoleDefinitionId string

@description('Tags applied to all taggable resources.')
param tags object

var authenticationName = 'auth-system'

resource rootActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${namePrefix}-root'
  location: 'global'
  tags: tags
  properties: {
    enabled: true
    groupShortName: 'ahmroot'
  }
}

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: healthModelLocation
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

resource appHealthReportOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: model
  name: guid(model.id, appIdentityPrincipalId, healthReportRoleDefinitionId)
  properties: {
    principalId: appIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: healthReportRoleDefinitionId
  }
}

resource authentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = {
  parent: model
  name: authenticationName
  properties: {
    displayName: 'Health model system identity'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

output modelId string = model.id
output modelName string = model.name
output modelPrincipalId string = model.identity.principalId
output authenticationSettingName string = authentication.name
output rootActionGroupId string = rootActionGroup.id
