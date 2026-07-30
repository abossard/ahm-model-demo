targetScope = 'resourceGroup'

@description('Principal ID of the health model system-assigned identity.')
param modelPrincipalId string

@description('Resource IDs the health model reads signals from. Returned unchanged once the read grants exist, so the entity module is created after them.')
param monitoredResources object

resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, modelPrincipalId, 'Reader')
  properties: {
    principalId: modelPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'acdd72a7-3385-48ef-bd42-f606fba81ae7'
    )
  }
}

resource monitoringReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, modelPrincipalId, 'Monitoring Reader')
  properties: {
    principalId: modelPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '43d0d8ad-25c7-4714-9337-8ba259a9fe05'
    )
  }
}

@description('The monitored resource IDs, now readable by the health model identity.')
output monitoredResources object = monitoredResources

