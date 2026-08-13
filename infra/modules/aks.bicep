targetScope = 'resourceGroup'

@description('Primary Azure region for the demo workload.')
param location string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Subnet used by the AKS system node pool.')
param aksSubnetId string

@description('Tags applied to all taggable resources.')
param tags object

resource cluster 'Microsoft.ContainerService/managedClusters@2026-04-01' = {
  name: 'aks-${namePrefix}'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'Base'
    tier: 'Free'
  }
  properties: {
    dnsPrefix: 'aks-${namePrefix}'
    kubernetesVersion: ''
    enableRBAC: true
    disableLocalAccounts: false
    agentPoolProfiles: [
      {
        name: 'system'
        count: 1
        vmSize: 'Standard_D2as_v6'
        osType: 'Linux'
        osSKU: 'Ubuntu'
        mode: 'System'
        type: 'VirtualMachineScaleSets'
        osDiskType: 'Managed'
        osDiskSizeGB: 32
        vnetSubnetID: aksSubnetId
        enableAutoScaling: false
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      loadBalancerSku: 'standard'
      outboundType: 'loadBalancer'
      podCidr: '10.244.0.0/16'
      serviceCidr: '10.0.0.0/16'
      dnsServiceIP: '10.0.0.10'
    }
    oidcIssuerProfile: {
      enabled: true
    }
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
    }
    addonProfiles: {
      omsagent: {
        enabled: false
      }
    }
    azureMonitorProfile: {
      metrics: {
        enabled: false
      }
    }
  }
}

output clusterId string = cluster.id
output clusterName string = cluster.name
output oidcIssuerUrl string = cluster.properties.oidcIssuerProfile.issuerURL
output kubeletObjectId string = cluster.properties.identityProfile.kubeletidentity.objectId
output nodeResourceGroup string = cluster.properties.nodeResourceGroup
