targetScope = 'resourceGroup'

// The MCP App Playground: a public host app, its MCP server, and the Cosmos DB account that holds the tables.
// It takes only names and ids of existing resources. ADR 0012 has the reasons.

@description('Primary Azure region for the demo workload.')
param location string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Suffix that makes every globally scoped name unique for this environment.')
param resourceToken string

@description('Tags applied to all taggable resources.')
param tags object

@description('Managed environment hosting both Container Apps.')
param environmentId string

@description('Container registry that both identities pull from.')
param registryName string

@description('Foundry account whose model deployment plays the blackjack dealer.')
param foundryAccountName string

@description('Model deployment the dealer calls.')
param modelDeploymentName string = 'gpt-54-mini'

@description('Virtual network whose resources resolve the Cosmos DB endpoint privately.')
param vnetId string

@description('Subnet that hosts the NIC of the private endpoint. The endpoint takes two addresses: the account and its region.')
param privateEndpointSubnetId string

@description('Image of the host app. Empty until the first deploy.')
param playgroundImage string = ''

@description('Image of the MCP server. Empty until the first deploy.')
param playgroundMcpImage string = ''

@description('Placeholder image used until a service is deployed for the first time.')
param placeholderImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

var hostAppName = 'ca-${namePrefix}-playground'
var mcpAppName = 'ca-${namePrefix}-playground-mcp'
var databaseName = 'playground'
// One container per kind of document (src/playground/mcp/src/ports.ts). The TTL counts from the last write.
var containers = [
  { name: 'tables', ttl: 21600 }
  { name: 'runs', ttl: 604800 }
  { name: 'players', ttl: 2592000 }
]

// The host is reachable from the internet without sign-in, so it gets an identity that can only pull its image.
resource hostIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-playground'
  location: location
  tags: tags
}

// The MCP server reads and writes the tables and calls the model. Nothing else holds these roles.
resource mcpIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-playground-mcp'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

resource foundry 'Microsoft.CognitiveServices/accounts@2026-03-01' existing = {
  name: foundryAccountName
}

resource hostAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, hostIdentity.id, 'AcrPull')
  properties: {
    principalId: hostIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

resource mcpAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, mcpIdentity.id, 'AcrPull')
  properties: {
    principalId: mcpIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

// Cognitive Services OpenAI User: chat completions on the account's deployments, nothing more.
resource dealerModelUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, mcpIdentity.id, 'Cognitive Services OpenAI User')
  properties: {
    principalId: mcpIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
    )
  }
}

// Serverless: no capacity to size and nothing billed while nobody plays. Closed like the session store:
// no keys, no public endpoint, one identity with a data role.
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: 'cosmos-${namePrefix}-${resourceToken}'
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    disableLocalAuth: true
    publicNetworkAccess: 'Disabled'
    minimalTlsVersion: 'Tls12'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

// The store reads a document by id and lists a partition by its last write. Only that is indexed, so the game
// state inside `body` costs nothing to write.
resource documentContainers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = [
  for container in containers: {
    parent: database
    name: container.name
    properties: {
      resource: {
        id: container.name
        partitionKey: {
          paths: [
            '/pk'
          ]
          kind: 'Hash'
        }
        defaultTtl: container.ttl
        indexingPolicy: {
          indexingMode: 'consistent'
          automatic: true
          includedPaths: [
            {
              path: '/updatedAt/?'
            }
          ]
          excludedPaths: [
            {
              path: '/*'
            }
          ]
        }
      }
    }
  }
]

// Cosmos DB Built-in Data Contributor: documents of this account. It cannot create containers or read keys.
resource cosmosDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, mcpIdentity.id, 'Cosmos DB Built-in Data Contributor')
  properties: {
    principalId: mcpIdentity.properties.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: cosmos.id
  }
}

resource cosmosPrivateEndpoint 'Microsoft.Network/privateEndpoints@2025-07-01' = {
  name: 'pe-${namePrefix}-cosmos'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'cosmos'
        properties: {
          privateLinkServiceId: cosmos.id
          groupIds: [
            'Sql'
          ]
        }
      }
    ]
  }
}

resource cosmosPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.documents.azure.com'
  location: 'global'
  tags: tags
}

resource cosmosPrivateDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: cosmosPrivateDnsZone
  name: 'link-vnet-${namePrefix}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

// The zone group writes both records of the endpoint, the account and its region, and keeps them current.
resource cosmosPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-07-01' = {
  parent: cosmosPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'cosmos'
        properties: {
          privateDnsZoneId: cosmosPrivateDnsZone.id
        }
      }
    ]
  }
  dependsOn: [
    cosmosPrivateDnsVnetLink
  ]
}

module mcpApp 'container-app.bicep' = {
  name: 'container-app-playground-mcp'
  params: {
    name: mcpAppName
    location: location
    serviceName: 'playground-mcp'
    environmentId: environmentId
    identityId: mcpIdentity.id
    registryLoginServer: registry.properties.loginServer
    image: playgroundMcpImage
    placeholderImage: placeholderImage
    targetPort: 8080
    external: true
    cpu: '0.5'
    memory: '1Gi'
    tags: tags
    env: [
      {
        name: 'PORT'
        value: '8080'
      }
      {
        name: 'AZURE_CLIENT_ID'
        value: mcpIdentity.properties.clientId
      }
      {
        name: 'PLAYGROUND_STORE'
        value: 'cosmos'
      }
      {
        name: 'COSMOS_ENDPOINT'
        value: cosmos.properties.documentEndpoint
      }
      {
        name: 'COSMOS_DATABASE'
        value: databaseName
      }
      {
        name: 'PLAYGROUND_LLM'
        value: 'azure'
      }
      {
        name: 'DEALER_ENDPOINT'
        value: 'https://${foundryAccountName}.openai.azure.com'
      }
      {
        name: 'DEALER_DEPLOYMENT'
        value: modelDeploymentName
      }
    ]
  }
  dependsOn: [
    mcpAcrPull
    dealerModelUser
    cosmosDataContributor
    cosmosPrivateDnsZoneGroup
    documentContainers
  ]
}

module hostApp 'container-app.bicep' = {
  name: 'container-app-playground'
  params: {
    name: hostAppName
    location: location
    serviceName: 'playground'
    environmentId: environmentId
    identityId: hostIdentity.id
    registryLoginServer: registry.properties.loginServer
    image: playgroundImage
    placeholderImage: placeholderImage
    targetPort: 8080
    external: true
    cpu: '0.5'
    memory: '1Gi'
    tags: tags
    env: [
      {
        name: 'PORT'
        value: '8080'
      }
      {
        name: 'MCP_URL'
        value: 'https://${mcpApp.outputs.fqdn}'
      }
    ]
  }
  dependsOn: [
    hostAcrPull
  ]
}

output hostFqdn string = hostApp.outputs.fqdn
output hostAppName string = hostApp.outputs.containerAppName
output mcpFqdn string = mcpApp.outputs.fqdn
output mcpAppName string = mcpApp.outputs.containerAppName
output cosmosAccountName string = cosmos.name
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output mcpIdentityPrincipalId string = mcpIdentity.properties.principalId
