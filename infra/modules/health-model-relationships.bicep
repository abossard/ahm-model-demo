targetScope = 'resourceGroup'

@description('Name of the Azure Health Model these relationships belong to.')
param modelName string

@description('Entity names, sourced from the entity module so the endpoints of every edge exist first.')
param entityNames object

@description('Application Insights resource whose discovered topology supplements this graph.')
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

resource relRootApplyHealthModelChanges 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-root-apply-health-model-changes'
  properties: {
    parentEntityName: entityNames.root
    childEntityName: entityNames.applyHealthModelChanges
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

resource relViewHealthModelModelRead 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-view-health-model-model-read'
  properties: {
    parentEntityName: entityNames.viewHealthModel
    childEntityName: entityNames.systemModelRead
    displayName: 'reads through'
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

resource relSendHealthReportsAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-send-health-reports-app-hosting'
  properties: {
    parentEntityName: entityNames.sendHealthReports
    childEntityName: entityNames.systemAppHostingReports
    displayName: 'runs on'
  }
}

resource relSendHealthReportsIngest 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-send-health-reports-ingest'
  properties: {
    parentEntityName: entityNames.sendHealthReports
    childEntityName: entityNames.systemReportIngest
    displayName: 'reports through'
  }
}

resource relReportAppHostingContainerApp 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-report-app-hosting-container-app'
  properties: {
    parentEntityName: entityNames.systemAppHostingReports
    childEntityName: entityNames.containerAppReports
    displayName: 'hosted by'
  }
}

resource relRunAgentTasksAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-run-agent-tasks-app-hosting'
  properties: {
    parentEntityName: entityNames.runAgentTasks
    childEntityName: entityNames.systemAppHostingTasks
    displayName: 'runs on'
  }
}

resource relRunAgentTasksAgentRuntime 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-run-agent-tasks-agent-runtime'
  properties: {
    parentEntityName: entityNames.runAgentTasks
    childEntityName: entityNames.systemAgentRuntime
    displayName: 'runs through'
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

resource relTaskAppHostingContainerApp 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-task-app-hosting-container-app'
  properties: {
    parentEntityName: entityNames.systemAppHostingTasks
    childEntityName: entityNames.containerAppTasks
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

resource relApplyAppHosting 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-apply-app-hosting'
  properties: {
    parentEntityName: entityNames.applyHealthModelChanges
    childEntityName: entityNames.systemAppHostingApply
    displayName: 'runs on'
  }
}

resource relApplyModelWrite 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-apply-model-write'
  properties: {
    parentEntityName: entityNames.applyHealthModelChanges
    childEntityName: entityNames.systemModelWrite
    displayName: 'writes through'
  }
}

resource relApplyState 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-apply-state'
  properties: {
    parentEntityName: entityNames.applyHealthModelChanges
    childEntityName: entityNames.systemApplyState
    displayName: 'records the result in'
  }
}

resource relApplyAppHostingContainerApp 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-apply-app-hosting-container-app'
  properties: {
    parentEntityName: entityNames.systemAppHostingApply
    childEntityName: entityNames.containerAppApply
    displayName: 'hosted by'
  }
}

resource relApplyStateStorage 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = {
  parent: model
  name: 'r-apply-state-storage'
  properties: {
    parentEntityName: entityNames.systemApplyState
    childEntityName: entityNames.sessionStorageApply
    displayName: 'backed by'
  }
}

@description('The discovery source, attached after every hand-authored relationship exists.')
output discoverySourceId string = discoverySourceId

output deterministicRelationshipCount int = 26
