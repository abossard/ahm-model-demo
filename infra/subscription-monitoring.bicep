targetScope = 'subscription'

param diagnosticSettingName string
param logAnalyticsWorkspaceId string
param taskResourceGroupId string

var healthReportRoleName = 'AHM Demo Health Report Operator'
var healthReportRoleDefinitionGuid = guid(subscription().id, healthReportRoleName)

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
      taskResourceGroupId
    ]
  }
}

output diagnosticSettingId string = activityLogDiagnostics.id
output healthReportRoleDefinitionId string = healthReportRole.id
