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

resource relRootSendHealthReports 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-send-health-reports'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.sendHealthReports
    displayName: 'serves'
  }
}

resource relRootRequestJourney 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-request-journey'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.requestJourney
    displayName: 'serves'
  }
}

resource relRootViewHealthModel 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-view-health-model'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.viewHealthModel
    displayName: 'serves'
  }
}

resource relRootAskCopilot 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-ask-copilot'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.askCopilot
    displayName: 'serves'
  }
}

resource relRootPlatform 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-platform'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.platformContext
    displayName: 'observes platform context'
  }
}

resource relRootDiscovery 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-discovery'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.discoveredTopology
    displayName: 'supplements with discovery'
  }
}

resource relSendHealthReportsAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-send-health-reports-app-hosting'
  properties: {
    parentEntityName: entityNames.sendHealthReports
    childEntityName: entityNames.systemAppHosting
    displayName: 'runs on'
  }
}

resource relRequestJourneyAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-request-journey-app-hosting'
  properties: {
    parentEntityName: entityNames.requestJourney
    childEntityName: entityNames.systemAppHosting
    displayName: 'runs on'
  }
}

resource relRequestJourneyDatabase 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-request-journey-database'
  properties: {
    parentEntityName: entityNames.requestJourney
    childEntityName: entityNames.systemDatabase
    displayName: 'persists through'
  }
}

resource relRequestJourneyQueueing 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-request-journey-queueing'
  properties: {
    parentEntityName: entityNames.requestJourney
    childEntityName: entityNames.systemQueueing
    displayName: 'enqueues through'
  }
}

resource relViewHealthModelAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-view-health-model-app-hosting'
  properties: {
    parentEntityName: entityNames.viewHealthModel
    childEntityName: entityNames.systemAppHosting
    displayName: 'runs on'
  }
}

resource relAskCopilotAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-ask-copilot-app-hosting'
  properties: {
    parentEntityName: entityNames.askCopilot
    childEntityName: entityNames.systemAppHosting
    displayName: 'runs on'
  }
}

resource relAskCopilotAgentRuntime 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-ask-copilot-agent-runtime'
  properties: {
    parentEntityName: entityNames.askCopilot
    childEntityName: entityNames.systemAgentRuntime
    displayName: 'reasons through'
  }
}

resource relAskCopilotAiInference 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-ask-copilot-ai-inference'
  properties: {
    parentEntityName: entityNames.askCopilot
    childEntityName: entityNames.systemAiInference
    displayName: 'infers through'
  }
}

resource relAppHostingContainerApp 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-app-hosting-container-app'
  properties: {
    parentEntityName: entityNames.systemAppHosting
    childEntityName: entityNames.containerApp
    displayName: 'hosted by'
  }
}

resource relAppHostingAks 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-app-hosting-aks'
  properties: {
    parentEntityName: entityNames.systemAppHosting
    childEntityName: entityNames.aksCluster
    displayName: 'hosted by'
  }
}

resource relDatabasePostgres 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-database-postgres'
  properties: {
    parentEntityName: entityNames.systemDatabase
    childEntityName: entityNames.postgres
    displayName: 'backed by'
  }
}

resource relQueueingQueueStorage 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-queueing-queue-storage'
  properties: {
    parentEntityName: entityNames.systemQueueing
    childEntityName: entityNames.queueStorage
    displayName: 'backed by'
  }
}

resource relAgentRuntimeAgentWeb 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-agent-runtime-agent-web'
  properties: {
    parentEntityName: entityNames.systemAgentRuntime
    childEntityName: entityNames.agentWebApp
    displayName: 'hosted by'
  }
}

resource relAgentRuntimeAgentApp 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-agent-runtime-agent-app'
  properties: {
    parentEntityName: entityNames.systemAgentRuntime
    childEntityName: entityNames.agentApp
    displayName: 'hosted by'
  }
}

resource relAiInferenceOpenai 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-ai-inference-openai'
  properties: {
    parentEntityName: entityNames.systemAiInference
    childEntityName: entityNames.openAiAccount
    displayName: 'backed by'
  }
}

@description('The discovery source, now safe to attach because every hand-authored edge exists.')
output discoverySourceId string = discoverySourceId

output deterministicRelationshipCount int = 21
