targetScope = 'resourceGroup'

@description('Name of the Azure Health Model.')
param modelName string

@description('Relationship specifications in this batch.')
param relationships array

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

resource relationshipResources 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [for relationship in relationships: {
  parent: model
  name: relationship.name
  properties: {
    parentEntityName: relationship.parentEntityName
    childEntityName: relationship.childEntityName
    displayName: relationship.displayName
  }
}]
