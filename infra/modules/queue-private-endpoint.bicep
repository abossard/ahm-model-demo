targetScope = 'resourceGroup'

@description('Primary Azure region for the demo workload.')
param location string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Storage account reached privately. Sourced from the storage module so the endpoint is created after the queue exists.')
param storageId string

@description('Subnet hosting the private endpoint NIC.')
param subnetId string

@description('Private DNS zone resolving the queue endpoint inside the virtual network.')
param privateDnsZoneId string

@description('Tags applied to all taggable resources.')
param tags object

resource queuePrivateEndpoint 'Microsoft.Network/privateEndpoints@2025-07-01' = {
  name: 'pe-${namePrefix}-queue'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'queue'
        properties: {
          privateLinkServiceId: storageId
          groupIds: [
            'queue'
          ]
          requestMessage: 'Private Queue access for the Azure Health Model demo'
        }
      }
    ]
  }
}

resource queuePrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-07-01' = {
  parent: queuePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'queue'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

