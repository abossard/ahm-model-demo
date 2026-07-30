targetScope = 'resourceGroup'

@description('Name of the Azure Health Model these relationships belong to.')
param modelName string

@description('Entity names, sourced from the entity module so the endpoints of every edge exist first.')
param entityNames object

@description('Application Insights resource whose discovered topology supplements this graph. Returned so the discovery rule is created after the hand-authored relationships.')
param discoverySourceId string

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

resource rootToJourney 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-request-journey'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.requestJourney
    displayName: 'serves requests through'
  }
}

resource journeyToRuntime 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-journey-runtime'
  properties: {
    parentEntityName: entityNames.requestJourney
    childEntityName: entityNames.applicationRuntime
    displayName: 'runs on'
  }
}

resource runtimeToApp 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-runtime-container-app'
  properties: {
    parentEntityName: entityNames.applicationRuntime
    childEntityName: entityNames.containerApp
    displayName: 'hosts'
  }
}

resource appToPostgres 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-app-postgres'
  properties: {
    parentEntityName: entityNames.containerApp
    childEntityName: entityNames.postgres
    displayName: 'persists events in'
  }
}

resource appToQueue 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-app-queue'
  properties: {
    parentEntityName: entityNames.containerApp
    childEntityName: entityNames.queueStorage
    displayName: 'enqueues events in'
  }
}

resource rootToPlatform 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-platform'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.platformContext
    displayName: 'observes platform context'
  }
}

resource rootToDiscovery 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-discovery'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.discoveredTopology
    displayName: 'supplements with discovery'
  }
}

@description('The discovery source, now safe to attach because every hand-authored edge exists.')
output discoverySourceId string = discoverySourceId

output deterministicRelationshipCount int = 7
