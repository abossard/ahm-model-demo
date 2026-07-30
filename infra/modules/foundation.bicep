targetScope = 'resourceGroup'

@description('Primary Azure region for the demo workload.')
param location string

@description('Suffix that makes every globally scoped name unique for this environment.')
param resourceToken string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Object ID of the signed-in Entra user used for PostgreSQL bootstrap.')
param adminObjectId string

@description('UPN of the signed-in Entra user used for PostgreSQL bootstrap.')
param adminUpn string

@description('Single IPv4 address allowed to bootstrap PostgreSQL.')
param adminIpAddress string

@description('Tags applied to all taggable resources.')
param tags object

var infrastructureSubnetName = 'snet-container-apps'
var privateEndpointSubnetName = 'snet-private-endpoints'

resource vnet 'Microsoft.Network/virtualNetworks@2025-07-01' = {
  name: 'vnet-${namePrefix}'
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
  name: 'privatelink.queue.${environment().suffixes.storage}'
  location: 'global'
  tags: tags
}

resource queuePrivateDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: queuePrivateDnsZone
  name: 'link-vnet-${namePrefix}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-app'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acrahm${resourceToken}'
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
  name: 'law-${namePrefix}'
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
  name: 'appi-${namePrefix}'
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

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'pg-ahm-${resourceToken}'
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
  name: 'cae-${namePrefix}'
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
output identityName string = identity.name
output identityClientId string = identity.properties.clientId
output identityPrincipalId string = identity.properties.principalId
output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output workspaceId string = workspace.id
output applicationInsightsName string = applicationInsights.name
output applicationInsightsId string = applicationInsights.id
output privateEndpointSubnetId string = '${vnet.id}/subnets/${privateEndpointSubnetName}'
output queuePrivateDnsZoneId string = queuePrivateDnsZone.id
output postgresId string = postgres.id
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output postgresDatabase string = database.name
output environmentId string = containerEnvironment.id
output environmentDefaultDomain string = containerEnvironment.properties.defaultDomain
