targetScope = 'resourceGroup'

@description('Name of the Azure Health Model.')
param modelName string

@description('Entity specifications in this batch.')
param entities array

@description('Reusable signal definitions bound to same-environment Azure resources.')
param signalProfiles array

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

resource entityResources 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = [for entity in entities: {
  parent: model
  name: entity.name
  properties: {
    displayName: entity.displayName
    icon: {
      iconName: 'SystemComponent'
    }
    healthObjective: 99
    impact: 'Standard'
    canvasPosition: {
      x: entity.localIndex * 12
      y: entity.level * 120
    }
    signalGroups: {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
      azureResource: {
        authenticationSetting: signalProfiles[entity.index % length(signalProfiles)].authenticationSetting
        azureResourceId: signalProfiles[entity.index % length(signalProfiles)].azureResourceId
        azureResourceKind: signalProfiles[entity.index % length(signalProfiles)].azureResourceKind
        resourceHealth: {
          enabled: 'Disabled'
        }
        signals: [
          {
            name: signalProfiles[entity.index % length(signalProfiles)].signalDefinitionName
            displayName: signalProfiles[entity.index % length(signalProfiles)].displayName
            signalKind: 'AzureResourceMetric'
            signalDefinitionName: signalProfiles[entity.index % length(signalProfiles)].signalDefinitionName
          }
        ]
      }
    }
  }
}]

output entityNames array = [for entity in entities: entity.name]
