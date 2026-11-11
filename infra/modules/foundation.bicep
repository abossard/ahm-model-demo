targetScope = 'resourceGroup'

@description('Primary Azure region for the demo workload.')
param location string

@description('Suffix that makes every globally scoped name unique for this environment.')
param resourceToken string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Tags applied to all taggable resources.')
param tags object

var infrastructureSubnetName = 'snet-container-apps'
var privateEndpointSubnetName = 'snet-private-endpoints'

// A workload profiles environment needs a subnet of at least /27 that nothing else uses, and its size cannot change
// after creation. The /26 leaves room for the extra addresses a revision change takes; the /25 is the smallest network
// that holds it next to the private endpoint subnet.
resource vnet 'Microsoft.Network/virtualNetworks@2025-07-01' = {
  name: 'vnet-${namePrefix}'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/25'
      ]
    }
    subnets: [
      {
        name: infrastructureSubnetName
        properties: {
          addressPrefix: '10.42.0.0/26'
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: privateEndpointSubnetName
        properties: {
          addressPrefix: '10.42.0.64/29'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-app'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'acrahm${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    roleAssignmentMode: 'LegacyRegistryPermissions'
    policies: {
      azureADAuthenticationAsArmPolicy: {
        status: 'enabled'
      }
    }
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

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-10-02-preview' = {
  name: 'cae-${namePrefix}'
  location: location
  tags: tags
  properties: {
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
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

output identityId string = identity.id
output identityClientId string = identity.properties.clientId
output identityPrincipalId string = identity.properties.principalId
output vnetId string = vnet.id
output privateEndpointSubnetId string = '${vnet.id}/subnets/${privateEndpointSubnetName}'
output registryName string = registry.name
output workspaceId string = workspace.id
output applicationInsightsName string = applicationInsights.name
output applicationInsightsId string = applicationInsights.id
output environmentId string = containerEnvironment.id

@description('Default domain of the Container Apps environment. A Container App named N is reachable at N.<domain>, so a URL is known before the app exists.')
output environmentDefaultDomain string = containerEnvironment.properties.defaultDomain
