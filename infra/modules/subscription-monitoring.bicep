targetScope = 'subscription'

param diagnosticSettingName string
param logAnalyticsWorkspaceId string
param taskResourceGroupId string

@description('Name of the azd environment. Keeps the custom role unique per environment so parallel stacks in one subscription never contend for the same role definition.')
param environmentName string

var healthReportRoleName = 'AHM Demo Health Report Operator (${environmentName})'
var healthReportRoleDefinitionGuid = guid(subscription().id, healthReportRoleName, taskResourceGroupId)

resource activityLogDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: diagnosticSettingName
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'Administrative'
        enabled: true
      }
      {
        category: 'ServiceHealth'
        enabled: true
      }
      {
        category: 'ResourceHealth'
        enabled: true
      }
      {
        category: 'Alert'
        enabled: true
      }
    ]
  }
}

resource healthReportRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: healthReportRoleDefinitionGuid
  properties: {
    roleName: healthReportRoleName
    description: 'Read one Azure Health Model and submit bounded entity health reports.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.CloudHealth/healthmodels/read'
          'Microsoft.CloudHealth/healthmodels/entities/read'
          'Microsoft.CloudHealth/healthmodels/relationships/read'
          'Microsoft.CloudHealth/healthmodels/entities/getHistory/action'
          'Microsoft.CloudHealth/healthmodels/entities/getSignalHistory/action'
          'Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      subscription().id
    ]
  }
}

var modelReaderRoleName = 'AHM Demo Health Model Reader (${environmentName})'
var modelWriterRoleName = 'AHM Demo Health Model Writer (${environmentName})'

// Reader covers */read but no CloudHealth actions; agents need history and recommendations too.
resource modelReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, modelReaderRoleName, taskResourceGroupId)
  properties: {
    roleName: modelReaderRoleName
    description: 'Read Azure Health Models with their history and signal recommendations, without changing them.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.CloudHealth/healthmodels/read'
          'Microsoft.CloudHealth/healthmodels/entities/read'
          'Microsoft.CloudHealth/healthmodels/relationships/read'
          'Microsoft.CloudHealth/healthmodels/signaldefinitions/read'
          'Microsoft.CloudHealth/healthmodels/discoveryrules/read'
          'Microsoft.CloudHealth/healthmodels/entities/getHistory/action'
          'Microsoft.CloudHealth/healthmodels/entities/getSignalHistory/action'
          'Microsoft.CloudHealth/healthmodels/entities/getDataAnnotations/action'
          'Microsoft.CloudHealth/healthmodels/entities/getSignalRecommendations/action'
          'Microsoft.CloudHealth/healthmodels/getRecommendedSignals/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      subscription().id
    ]
  }
}

// Apply writes entities, signal definitions and relationships; never models or their identities.
resource modelWriterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, modelWriterRoleName, taskResourceGroupId)
  properties: {
    roleName: modelWriterRoleName
    description: 'Change entities, signal definitions and relationships of existing Azure Health Models.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.CloudHealth/healthmodels/read'
          'Microsoft.CloudHealth/healthmodels/entities/read'
          'Microsoft.CloudHealth/healthmodels/entities/write'
          'Microsoft.CloudHealth/healthmodels/entities/delete'
          'Microsoft.CloudHealth/healthmodels/relationships/read'
          'Microsoft.CloudHealth/healthmodels/relationships/write'
          'Microsoft.CloudHealth/healthmodels/relationships/delete'
          'Microsoft.CloudHealth/healthmodels/signaldefinitions/read'
          'Microsoft.CloudHealth/healthmodels/signaldefinitions/write'
          'Microsoft.CloudHealth/healthmodels/signaldefinitions/delete'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      subscription().id
    ]
  }
}

output healthReportRoleDefinitionId string = healthReportRole.id

@description('Assigned to each hosted agent identity after the agent is created.')
output modelReaderRoleDefinitionId string = modelReaderRole.id

output modelWriterRoleDefinitionId string = modelWriterRole.id

output healthReportRoleName string = healthReportRoleName
