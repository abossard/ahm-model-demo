targetScope = 'resourceGroup'

@description('Primary Azure region for the demo workload.')
param location string = resourceGroup().location

@description('Object ID of the signed-in Entra user used for PostgreSQL bootstrap.')
param adminObjectId string

@description('UPN of the signed-in Entra user used for PostgreSQL bootstrap.')
param adminUpn string

@description('Single IPv4 address allowed to bootstrap PostgreSQL.')
param adminIpAddress string

@description('Tags applied to all taggable resources.')
param tags object

var suffix = uniqueString(subscription().id, resourceGroup().id)
var acrName = 'acrahm${suffix}'
var storageName = 'stahm${suffix}'
var postgresName = 'pg-ahm-${suffix}'
var vnetName = 'vnet-ahm-movie-demo'
var infrastructureSubnetName = 'snet-container-apps'
var privateEndpointSubnetName = 'snet-private-endpoints'
var queuePrivateEndpointName = 'pe-ahm-movie-demo-queue'
var queuePrivateDnsZoneName = 'privatelink.queue.${environment().suffixes.storage}'

resource vnet 'Microsoft.Network/virtualNetworks@2025-07-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/22'
      ]
    }
    subnets: [
      {
        name: infrastructureSubnetName
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: []
        }
      }
      {
        name: privateEndpointSubnetName
        properties: {
          addressPrefix: '10.42.2.0/29'
          delegations: []
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource queuePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: queuePrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource queuePrivateDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: queuePrivateDnsZone
  name: 'link-vnet-ahm-movie-demo'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-ahm-demo-app'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'law-ahm-movie-demo'
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    workspaceCapping: {
      dailyQuotaGb: 1
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-ahm-movie-demo'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    DisableLocalAuth: true
    IngestionMode: 'LogAnalytics'
    RetentionInDays: 30
    WorkspaceResourceId: workspace.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: []
    }
  }
}

resource requestQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'requests'
  properties: {
    metadata: {
      purpose: 'azure-health-model-movie-demo'
    }
  }
}

resource queueDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: queueService
  name: 'diag-queue-to-law'
  properties: {
    workspaceId: workspace.id
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource queuePrivateEndpoint 'Microsoft.Network/privateEndpoints@2025-07-01' = {
  name: queuePrivateEndpointName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${privateEndpointSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'queue'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'queue'
          ]
          requestMessage: 'Private Queue access for the Azure Health Model demo'
        }
      }
    ]
  }
  dependsOn: [
    requestQueue
  ]
}

resource queuePrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-07-01' = {
  parent: queuePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'queue'
        properties: {
          privateDnsZoneId: queuePrivateDnsZone.id
        }
      }
    ]
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: subscription().tenantId
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    storage: {
      autoGrow: 'Disabled'
      storageSizeGB: 32
    }
  }
}

resource entraAdministrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: postgres
  name: adminObjectId
  properties: {
    principalName: adminUpn
    principalType: 'User'
    tenantId: subscription().tenantId
  }
}

resource azureServicesFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource bootstrapFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'BootstrapAdmin'
  properties: {
    startIpAddress: adminIpAddress
    endIpAddress: adminIpAddress
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'demo'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: postgres
  name: 'diag-postgres-to-law'
  properties: {
    workspaceId: workspace.id
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-10-02-preview' = {
  name: 'cae-ahm-movie-demo'
  location: location
  tags: tags
  properties: union({
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: '${vnet.id}/subnets/${infrastructureSubnetName}'
      internal: false
    }
    zoneRedundant: false
  }, {
    environmentMode: 'ConsumptionOnly'
  })
}

output identityId string = identity.id
output identityClientId string = identity.properties.clientId
output identityPrincipalId string = identity.properties.principalId
output registryId string = registry.id
output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
output applicationInsightsId string = applicationInsights.id
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString
output storageId string = storage.id
output storageName string = storage.name
output queueId string = requestQueue.id
output vnetId string = vnet.id
output infrastructureSubnetId string = '${vnet.id}/subnets/${infrastructureSubnetName}'
output privateEndpointSubnetId string = '${vnet.id}/subnets/${privateEndpointSubnetName}'
output queuePrivateEndpointId string = queuePrivateEndpoint.id
output queuePrivateDnsZoneId string = queuePrivateDnsZone.id
output postgresId string = postgres.id
output postgresName string = postgres.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output environmentId string = containerEnvironment.id
