targetScope = 'resourceGroup'

param modelName string
param healthModelLocation string
param containerAppId string
param postgresId string
param workspaceId string
param applicationInsightsId string
param tags object

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: healthModelLocation
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

resource authentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = {
  parent: model
  name: 'auth-system'
  properties: {
    displayName: 'Survey model system identity'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

module access 'health-model-access.bicep' = {
  name: 'survey-health-model-access'
  params: {
    modelPrincipalId: model.identity.principalId
    monitoredResources: {
      containerApp: containerAppId
      postgres: postgresId
      logAnalyticsWorkspace: workspaceId
      applicationInsights: applicationInsightsId
    }
  }
}

module entities 'survey-health-entities.bicep' = {
  name: 'survey-health-entities'
  params: {
    modelName: model.name
    authenticationName: authentication.name
    containerAppId: containerAppId
    postgresId: postgresId
    workspaceId: workspaceId
    monitoredResources: access.outputs.monitoredResources
  }
}

output modelName string = model.name
output modelId string = model.id
