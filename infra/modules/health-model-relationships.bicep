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

resource relRootViewHealthModel 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-view-health-model'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.viewHealthModel
    displayName: 'serves'
  }
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

resource relRootRunAgentTasks 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-run-agent-tasks'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.runAgentTasks
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

resource relViewHealthModelAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-view-health-model-app-hosting'
  properties: {
    parentEntityName: entityNames.viewHealthModel
    childEntityName: entityNames.systemAppHosting
    displayName: 'runs on'
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

resource relRunAgentTasksAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-run-agent-tasks-app-hosting'
  properties: {
    parentEntityName: entityNames.runAgentTasks
    childEntityName: entityNames.systemAppHosting
    displayName: 'runs on'
  }
}

resource relRunAgentTasksAgentRuntime 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-run-agent-tasks-agent-runtime'
  properties: {
    parentEntityName: entityNames.runAgentTasks
    childEntityName: entityNames.systemAgentRuntime
    displayName: 'reasons through'
  }
}

resource relRunAgentTasksAiInference 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-run-agent-tasks-ai-inference'
  properties: {
    parentEntityName: entityNames.runAgentTasks
    childEntityName: entityNames.systemAiInference
    displayName: 'infers through'
  }
}

resource relRunAgentTasksSessionStore 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-run-agent-tasks-session-store'
  properties: {
    parentEntityName: entityNames.runAgentTasks
    childEntityName: entityNames.systemSessionStore
    displayName: 'keeps sessions in'
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

resource relAgentRuntimeHostedAgent 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-agent-runtime-hosted-agent'
  properties: {
    parentEntityName: entityNames.systemAgentRuntime
    childEntityName: entityNames.hostedAgent
    displayName: 'hosted by'
  }
}

resource relAgentRuntimeMcpServer 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-agent-runtime-mcp-server'
  properties: {
    parentEntityName: entityNames.systemAgentRuntime
    childEntityName: entityNames.mcpServer
    displayName: 'reads Azure through'
  }
}

resource relAiInferenceFoundryAccount 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-ai-inference-foundry-account'
  properties: {
    parentEntityName: entityNames.systemAiInference
    childEntityName: entityNames.foundryAccount
    displayName: 'backed by'
  }
}

resource relSessionStoreSessionStorage 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-session-store-session-storage'
  properties: {
    parentEntityName: entityNames.systemSessionStore
    childEntityName: entityNames.sessionStorage
    displayName: 'backed by'
  }
}

@description('The discovery source, now safe to attach because every hand-authored edge exists.')
output discoverySourceId string = discoverySourceId

output deterministicRelationshipCount int = 16
