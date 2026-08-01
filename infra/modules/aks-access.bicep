targetScope = 'resourceGroup'

@description('Container registry the AKS kubelet identity pulls images from.')
param registryName string

@description('Object ID of the AKS kubelet identity.')
param kubeletObjectId string

@description('Name of the workload user-assigned identity.')
param identityName string

@description('AKS OIDC issuer URL.')
param oidcIssuerUrl string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, kubeletObjectId, 'AcrPull')
  properties: {
    principalId: kubeletObjectId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

resource workloadCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'fic-${namePrefix}-aks-workload'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:ahm:workload'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output registryLoginServer string = registry.properties.loginServer
output workloadCredentialName string = workloadCredential.name
