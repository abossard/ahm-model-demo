targetScope = 'resourceGroup'

// Starts empty. A Design task's approved changes are applied here, so the web app never creates models.

param modelName string
param healthModelLocation string
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
    displayName: 'Design model system identity'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

module access 'health-model-access.bicep' = {
  name: 'design-health-model-access'
  params: {
    modelPrincipalId: model.identity.principalId
    monitoredResources: {}
  }
}

output modelName string = model.name
output modelId string = model.id
