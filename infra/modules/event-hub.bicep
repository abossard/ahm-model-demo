targetScope = 'resourceGroup'

@description('Primary Azure region for the Event Hubs diagnostic destination.')
param location string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Suffix that makes the Event Hubs namespace globally unique.')
param resourceToken string

@description('Tags applied to all taggable resources.')
param tags object

var namespaceName = toLower('ehns-${namePrefix}-${take(resourceToken, 13)}')
var eventHubName = 'diagnostics'

resource namespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  tags: tags
  sku: {
    capacity: 1
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    disableLocalAuth: false
    isAutoInflateEnabled: true
    maximumThroughputUnits: 4
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
  }
}

resource eventHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: namespace
  name: eventHubName
  properties: {
    messageRetentionInDays: 1
    partitionCount: 4
    status: 'Active'
  }
}

// Azure Monitor requires Manage, Send and Listen on the namespace authorization rule.
resource diagnosticsAuthorizationRule 'Microsoft.EventHub/namespaces/authorizationRules@2024-01-01' = {
  parent: namespace
  name: 'azure-monitor-diagnostics'
  properties: {
    rights: [
      'Manage'
      'Send'
      'Listen'
    ]
  }
}

output namespaceName string = namespace.name
output namespaceId string = namespace.id
output eventHubName string = eventHub.name
output eventHubId string = eventHub.id
output authorizationRuleId string = diagnosticsAuthorizationRule.id
