targetScope = 'resourceGroup'

@description('Container App name.')
param name string

@description('Primary Azure region for the demo workload.')
param location string

@description('azd service this Container App hosts.')
param serviceName string

@description('Managed environment hosting the Container App.')
param environmentId string

@description('Resource ID of the workload user-assigned identity.')
param identityId string

@description('Registry the identity may pull from.')
param registryLoginServer string

@description('Image to run. Empty on the first provision, when the placeholder runs until azd deploy publishes the real image.')
param image string

@description('Placeholder image used until the service is deployed for the first time.')
param placeholderImage string

@description('Port the container listens on.')
param targetPort int

@description('Whether ingress is reachable from outside the managed environment.')
param external bool

@description('Environment variables passed to the container.')
param env array

@description('CPU cores allocated to the container.')
param cpu string

@description('Memory allocated to the container.')
param memory string

@description('Tags applied to all taggable resources.')
param tags object

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: union(tags, {
    'azd-service-name': serviceName
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: external
        allowInsecure: false
        targetPort: targetPort
        transport: 'auto'
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: serviceName
          image: empty(image) ? placeholderImage : image
          env: env
          resources: {
            cpu: json(cpu)
            memory: memory
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

output containerAppId string = containerApp.id
output containerAppName string = containerApp.name
output fqdn string = containerApp.properties.configuration.ingress.fqdn
