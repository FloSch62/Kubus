/**
 * Vendored output of the upstream Retina helm chart (Apache-2.0), pinned —
 * kept verbatim so it can be diffed against a fresh render when bumping
 * NETWORK_AGENT_VERSION in network-agent.ts:
 *
 *   helm template retina oci://ghcr.io/microsoft/retina/charts/retina \
 *     --version <ver> --namespace kube-system --include-crds \
 *     --set image.tag=<ver> --set operator.enabled=true --set operator.tag=<ver> \
 *     --set logLevel=info --set enablePodLevel=true --set remoteContext=true \
 *     --set enabledPlugin_linux='["dropreason","packetforward","linuxutil","dns","packetparser","tcpretrans"]'
 *
 * Deviations from the render, re-apply when bumping:
 * - dropped: helm test Pod, Services, Windows DaemonSet/ConfigMap, captures +
 *   tracesconfigurations CRDs (operator-capture features Kubus doesn't use)
 * - added "metricsconfigurations" to the retina-cluster-reader ClusterRole —
 *   the agent watches them but the chart only grants retinaendpoints
 * Kubus stamps its managed-by label at install time.
 */
export const RETINA_MANIFEST_YAML = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  annotations:
    controller-gen.kubebuilder.io/version: v0.19.0
  name: metricsconfigurations.retina.sh
spec:
  group: retina.sh
  names:
    categories:
    - retina
    kind: MetricsConfiguration
    listKind: MetricsConfigurationList
    plural: metricsconfigurations
    singular: metricsconfiguration
  scope: Cluster
  versions:
  - name: v1alpha1
    schema:
      openAPIV3Schema:
        description: MetricsConfiguration contains the specification for the retina
          plugin metrics
        properties:
          apiVersion:
            description: |-
              APIVersion defines the versioned schema of this representation of an object.
              Servers should convert recognized schemas to the latest internal value, and
              may reject unrecognized values.
              More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#resources
            type: string
          kind:
            description: |-
              Kind is a string value representing the REST resource this object represents.
              Servers may infer this from the endpoint the client submits requests to.
              Cannot be updated.
              In CamelCase.
              More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds
            type: string
          metadata:
            type: object
          spec:
            description: Specification of the desired behavior of the RetinaMetrics.
              Can be omitted because this is for advanced metrics.
            properties:
              contextOptions:
                items:
                  description: MetricsContextOptions indicates the configuration for
                    retina plugin metrics
                  properties:
                    additionalLabels:
                      description: |-
                        AdditionalContext represents the additional context of the metrics collected
                        Such as Direction (ingress/egress)
                      items:
                        type: string
                      type: array
                      x-kubernetes-list-type: set
                    destinationLabels:
                      description: |-
                        DestinationLabels represents the destination context of the metrics collected
                        Such as IP, pod, port, workload (deployment/replicaset/statefulset/daemonset)
                      items:
                        type: string
                      type: array
                      x-kubernetes-list-type: set
                    metricName:
                      description: MetricName indicates the name of the metric
                      type: string
                    sourceLabels:
                      description: |-
                        SourceLabels represents the source context of the metrics collected
                        Such as IP, pod, port
                      items:
                        type: string
                      type: array
                      x-kubernetes-list-type: set
                    ttl:
                      description: |-
                        TTL represents the time-to-live of the metrics collected
                        Metrics which have not been updated within the TTL will be removed from export
                      type: string
                  required:
                  - metricName
                  type: object
                type: array
              namespaces:
                description: MetricsNamespaces indicates the namespaces to include
                  or exclude in metric collection
                properties:
                  exclude:
                    items:
                      type: string
                    type: array
                    x-kubernetes-list-type: set
                  include:
                    items:
                      type: string
                    type: array
                    x-kubernetes-list-type: set
                type: object
            required:
            - contextOptions
            - namespaces
            type: object
          status:
            properties:
              lastKnownSpec:
                description: Specification of the desired behavior of the RetinaMetrics.
                  Can be omitted because this is for advanced metrics.
                properties:
                  contextOptions:
                    items:
                      description: MetricsContextOptions indicates the configuration
                        for retina plugin metrics
                      properties:
                        additionalLabels:
                          description: |-
                            AdditionalContext represents the additional context of the metrics collected
                            Such as Direction (ingress/egress)
                          items:
                            type: string
                          type: array
                          x-kubernetes-list-type: set
                        destinationLabels:
                          description: |-
                            DestinationLabels represents the destination context of the metrics collected
                            Such as IP, pod, port, workload (deployment/replicaset/statefulset/daemonset)
                          items:
                            type: string
                          type: array
                          x-kubernetes-list-type: set
                        metricName:
                          description: MetricName indicates the name of the metric
                          type: string
                        sourceLabels:
                          description: |-
                            SourceLabels represents the source context of the metrics collected
                            Such as IP, pod, port
                          items:
                            type: string
                          type: array
                          x-kubernetes-list-type: set
                        ttl:
                          description: |-
                            TTL represents the time-to-live of the metrics collected
                            Metrics which have not been updated within the TTL will be removed from export
                          type: string
                      required:
                      - metricName
                      type: object
                    type: array
                  namespaces:
                    description: MetricsNamespaces indicates the namespaces to include
                      or exclude in metric collection
                    properties:
                      exclude:
                        items:
                          type: string
                        type: array
                        x-kubernetes-list-type: set
                      include:
                        items:
                          type: string
                        type: array
                        x-kubernetes-list-type: set
                    type: object
                required:
                - contextOptions
                - namespaces
                type: object
              reason:
                type: string
              state:
                default: Initialized
                enum:
                - Initialized
                - Accepted
                - Errored
                - Warning
                type: string
            required:
            - reason
            - state
            type: object
        type: object
    served: true
    storage: true
    subresources:
      status: {}
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  annotations:
    controller-gen.kubebuilder.io/version: v0.19.0
  name: retinaendpoints.retina.sh
spec:
  group: retina.sh
  names:
    kind: RetinaEndpoint
    listKind: RetinaEndpointList
    plural: retinaendpoints
    shortNames:
    - ke
    singular: retinaendpoint
  scope: Namespaced
  versions:
  - additionalPrinterColumns:
    - jsonPath: .spec.podIP
      name: Pod IP
      type: string
    - jsonPath: .spec.ownerReferences
      name: Referenced By
      priority: 1
      type: string
    name: v1alpha1
    schema:
      openAPIV3Schema:
        description: RetinaEndpoint is the Schema for the retinaendpoints API
        properties:
          apiVersion:
            description: |-
              APIVersion defines the versioned schema of this representation of an object.
              Servers should convert recognized schemas to the latest internal value, and
              may reject unrecognized values.
              More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#resources
            type: string
          kind:
            description: |-
              Kind is a string value representing the REST resource this object represents.
              Servers may infer this from the endpoint the client submits requests to.
              Cannot be updated.
              In CamelCase.
              More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds
            type: string
          metadata:
            type: object
          spec:
            description: RetinaEndpointSpec defines the desired state of RetinaEndpoint
            properties:
              annotations:
                additionalProperties:
                  type: string
                type: object
              containers:
                items:
                  properties:
                    id:
                      type: string
                    name:
                      type: string
                  type: object
                type: array
              labels:
                additionalProperties:
                  type: string
                type: object
              nodeIP:
                type: string
              ownerReferences:
                items:
                  properties:
                    apiVersion:
                      type: string
                    kind:
                      type: string
                    name:
                      type: string
                  type: object
                type: array
              podIP:
                type: string
              podIPs:
                items:
                  type: string
                type: array
            type: object
          status:
            description: RetinaEndpointStatus defines the observed state of RetinaEndpoint
            type: object
        type: object
    served: true
    storage: true
    subresources:
      status: {}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  labels:
    app.kubernetes.io/name: serviceaccount
    app.kubernetes.io/instance: retina-operator
    app.kubernetes.io/component: rbac
    app.kubernetes.io/created-by: operator
    app.kubernetes.io/part-of: operator
    app.kubernetes.io/managed-by: kustomize
  name: retina-operator
  namespace: kube-system
---
apiVersion: v1
kind: ServiceAccount
metadata:
  labels:
    helm.sh/chart: retina-v1.2.3
    app.kubernetes.io/name: retina
    app.kubernetes.io/instance: retina
    app.kubernetes.io/version: "0.0.1"
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/part-of: retina
    app.kubernetes.io/component: rbac
    k8s-app: retina
  name: retina-agent
  namespace: kube-system
---
apiVersion: v1
kind: ConfigMap
metadata:
  labels:
    helm.sh/chart: retina-v1.2.3
    app.kubernetes.io/name: retina
    app.kubernetes.io/instance: retina
    app.kubernetes.io/version: "0.0.1"
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/part-of: retina
    app.kubernetes.io/component: config
    k8s-app: retina
  name: retina-config
  namespace: kube-system
data:
  config.yaml: |-
    apiServer:
      host: 0.0.0.0
      port: 10093
    logLevel: info
    enabledPlugin: ["dropreason","packetforward","linuxutil","dns","packetparser","tcpretrans"]
    metricsInterval: 10s
    metricsIntervalDuration: 10s
    enableTCX: 
    enableTelemetry: false
    enablePodLevel: true
    enableConntrackMetrics: false
    remoteContext: true
    enableAnnotations: false
    bypassLookupIPOfInterest: false
    dataAggregationLevel: low
    telemetryInterval: 15m
    dataSamplingRate: 1
    packetParserRingBuffer: disabled
    packetParserRingBufferSize: 8.388608e+06
    filterMapMaxEntries: 255
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: "retina-operator-config"
  namespace: kube-system
data:
  operator-config.yaml: |-
    installCRDs: true
    enableTelemetry: false
    remoteContext: true
    captureDebug: true
    captureJobNumLimit: 0
    enableManagedStorageAccount: false
    telemetryInterval: 5m
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  creationTimestamp: null
  name: "retina-operator-role"
rules:
  - apiGroups: 
      - "apiextensions.k8s.io"
    resources: 
      - "customresourcedefinitions"
    verbs: 
      - "create"
      - "get"
      - "update"
      - "delete"
      - "patch"
  - apiGroups:
    - ""
    resources:
      - pods
    verbs:
      - get
      - list
      - watch
  - apiGroups:
    - ""
    resources:
      - namespaces
    verbs:
      - get
      - list
      - watch
  - apiGroups:
      - retina.sh
    resources:
      - retinaendpoints
      - metricsconfigurations
    verbs:
      - create
      - delete
      - get
      - list
      - patch
      - update
      - watch
  - apiGroups:
      - retina.sh
    resources:
      - metricsconfigurations
    verbs:
      - create
      - delete
      - get
      - list
      - patch
      - update
      - watch
  - apiGroups:
      - retina.sh
    resources:
      - metricsconfigurations/status
    verbs:
      - create
      - delete
      - get
      - list
      - patch
      - update
      - watch
  - apiGroups:
      - retina.sh
    resources:
      - retinaendpoints/finalizers
    verbs:
      - update
  - apiGroups:
      - retina.sh
    resources:
      - retinaendpoints/status
    verbs:
      - get
      - patch
      - update
  - apiGroups:
      - ""
    resources:
    - namespaces
    - pods
    - nodes
    verbs:
    - get
    - list
  - apiGroups:
      - ""
    resources:
    - secrets
    verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
  - apiGroups:
      - batch
    resources:
    - jobs
    verbs:
    - create
    - delete
    - deletecollection
    - get
    - list
    - patch
    - update
    - watch
  - apiGroups:
      - batch
    resources:
    - jobs/status
    verbs:
    - get
  - apiGroups:
    - retina.sh
    resources:
    - captures
    verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
  - apiGroups:
      - retina.sh
    resources:
    - captures/finalizers
    verbs:
    - update
  - apiGroups:
      - retina.sh
    resources:
    - captures/status
    verbs:
    - get
    - patch
    - update
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  labels:
    k8s-app: retina
    helm.sh/chart: retina-v1.2.3
    app.kubernetes.io/name: retina
    app.kubernetes.io/instance: retina
    app.kubernetes.io/version: "0.0.1"
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/part-of: retina
    app.kubernetes.io/component: rbac
  namespace: kube-system
  name: retina-cluster-reader
rules:
  - apiGroups: [""] # "" indicates the core API group
    resources: ["pods", "services", "replicationcontrollers", "nodes", "namespaces"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["networking.azure.com"]
    resources: ["clusterobservers"]
    verbs: ["get", "list", "watch"]
  - apiGroups:
      - retina.sh
    resources:
      - retinaendpoints
      - metricsconfigurations
    verbs:
      - get
      - list
      - watch
  - apiGroups:
      - retina.sh
    resources:
      - retinaendpoints
      - metricsconfigurations
    verbs:
      - create
      - delete
      - get
      - list
      - patch
      - update
      - watch
  - apiGroups:
      - retina.sh
    resources:
      - metricsconfigurations
    verbs:
      - create
      - delete
      - get
      - list
      - patch
      - update
      - watch
  - apiGroups:
      - retina.sh
    resources:
      - retinaendpoints/finalizers
    verbs:
      - update
  - apiGroups:
      - retina.sh
    resources:
      - retinaendpoints/status
    verbs:
      - get
      - patch
      - update
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  labels:
    app.kubernetes.io/name: clusterrolebinding
    app.kubernetes.io/instance: "retina-operator-rolebinding"
    app.kubernetes.io/component: rbac
    app.kubernetes.io/created-by: operator
    app.kubernetes.io/part-of: operator
    app.kubernetes.io/managed-by: kustomize
  name: "retina-operator-rolebinding"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: "retina-operator-role"
subjects:
- kind: ServiceAccount
  name: retina-operator
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  labels:
    k8s-app: retina
    helm.sh/chart: retina-v1.2.3
    app.kubernetes.io/name: retina
    app.kubernetes.io/instance: retina
    app.kubernetes.io/version: "0.0.1"
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/part-of: retina
    app.kubernetes.io/component: rbac
  name: retina-cluster-reader-binding
  namespace: kube-system
subjects:
  - kind: ServiceAccount
    name: retina-agent
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: retina-cluster-reader
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: retina-agent
  namespace: kube-system
  labels:
    helm.sh/chart: retina-v1.2.3
    app.kubernetes.io/name: retina
    app.kubernetes.io/instance: retina
    app.kubernetes.io/version: "0.0.1"
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/part-of: retina
    app.kubernetes.io/component: workload
    k8s-app: retina
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: retina
      app.kubernetes.io/instance: retina
      app.kubernetes.io/component: workload
  template:
    metadata:
      labels:
        helm.sh/chart: retina-v1.2.3
        app.kubernetes.io/name: retina
        app.kubernetes.io/instance: retina
        app.kubernetes.io/version: "0.0.1"
        app.kubernetes.io/managed-by: Helm
        app.kubernetes.io/part-of: retina
        app.kubernetes.io/component: workload
        k8s-app: retina
      annotations:
        prometheus.io/port: "10093"
        prometheus.io/scrape: "true"
        checksum/config: 1f694071dd0f5a242397656a5db7472c38a6692fa47299112e1728f38a3ee1a7
    spec:
      hostNetwork: true
      serviceAccountName: retina-agent
      initContainers:
        - name: init-retina
          image: ghcr.io/microsoft/retina/retina-init:v1.2.3
          imagePullPolicy: Always
          args:
            - --config
            - "/retina/config/config.yaml"
          terminationMessagePolicy: FallbackToLogsOnError
          securityContext:
            privileged: true
          volumeMounts:
          - name: bpf
            mountPath: /sys/fs/bpf
            mountPropagation: Bidirectional
          - name: config
            mountPath: /retina/config
          - name: tmp
            mountPath: /tmp
      containers:
        - name: retina 
          readinessProbe:
            httpGet:
              path: /metrics
              port: 10093
            initialDelaySeconds: 30
            periodSeconds: 30
            timeoutSeconds: 1
            failureThreshold: 3
            successThreshold: 1
          livenessProbe:
            httpGet:
              path: /metrics
              port: 10093
            initialDelaySeconds: 30
            periodSeconds: 30
            timeoutSeconds: 1
            failureThreshold: 3
            successThreshold: 1
          image: ghcr.io/microsoft/retina/retina-agent:v1.2.3
          imagePullPolicy: Always
          command:
          - /retina/controller
          args:
          - --health-probe-bind-address=:18081
          - --metrics-bind-address=:18080
          - "--config"
          - "/retina/config/config.yaml"
          ports:
          - name: retina
            containerPort: 10093
          resources:
            limits:
              cpu: 500m
              memory: 300Mi
            requests:
              cpu: 500m
              memory: 300Mi
          env:
          - name: POD_NAME
            valueFrom:
              fieldRef:
                apiVersion: v1
                fieldPath: metadata.name
          - name: NODE_NAME
            valueFrom:
                fieldRef:
                  apiVersion: v1
                  fieldPath: spec.nodeName
          - name: NODE_IP
            valueFrom:
                fieldRef:
                  apiVersion: v1
                  fieldPath: status.hostIP
          securityContext:
            capabilities:
              add:
              - SYS_ADMIN
              - NET_ADMIN
              - IPC_LOCK
              - SYS_RESOURCE
            privileged: false
          volumeMounts:
          - name: bpf
            mountPath: /sys/fs/bpf
          - name: cgroup
            mountPath: /sys/fs/cgroup
          - name: config
            mountPath: /retina/config
          - name: debug
            mountPath: /sys/kernel/debug
          - name: host-os-release
            mountPath: /etc/os-release
          - name: tmp
            mountPath: /tmp
          - name: trace
            mountPath: /sys/kernel/tracing
      terminationGracePeriodSeconds: 90 # Allow for retina to cleanup plugin resources.
      volumes:
      - name: bpf
        hostPath:
          path: /sys/fs/bpf
      - name: cgroup
        hostPath:
          path: /sys/fs/cgroup
      - name: config
        configMap:
          name: retina-config
      - name: debug
        hostPath:
          path: /sys/kernel/debug
      - name: host-os-release
        hostPath:
          path: /etc/os-release
          type: FileOrCreate
      - name: tmp
        emptyDir: {}
      - name: trace
        hostPath:
          path: /sys/kernel/tracing
      nodeSelector:
        kubernetes.io/os: linux
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: retina-operator
  namespace: kube-system
  labels:
    app: retina-operator
    control-plane: retina-operator
    app.kubernetes.io/name: deployment
    app.kubernetes.io/instance: retina-operator
    app.kubernetes.io/component: retina-operator
    app.kubernetes.io/created-by: operator
    app.kubernetes.io/part-of: operator
    app.kubernetes.io/managed-by: kustomize
spec:
  selector:
    matchLabels:
      control-plane: retina-operator
  replicas: 1
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/default-container: retina-operator
        prometheus.io/port: "8080"
        prometheus.io/scrape: "true"
        # Roll the operator pod whenever its ConfigMap rendering changes,
        # so \`helm upgrade\` applies new config values (e.g. \`remoteContext\`)
        # without requiring a manual \`kubectl rollout restart\`.
        checksum/config: 0764878cb46e94b40e1ad987bf32151e71d618f3271eeeb2eec55e337f706008
      labels:
        app: retina-operator
        control-plane: retina-operator
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: kubernetes.io/os
                operator: In
                values:
                - linux
      securityContext:
        runAsNonRoot: true
      containers:
        - image: ghcr.io/microsoft/retina/retina-operator:v1.2.3
          name: retina-operator
          command:
          - /retina-operator
          ports:
          - containerPort: 8080
            name: retina-operator
          args:
          - "--config"
          - "/retina/operator-config.yaml"
          volumeMounts:
            - name: "retina-operator-config"
              mountPath: /retina/
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - "ALL"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8081
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            limits:
              cpu: 500m
              memory: 128Mi
            requests:
              cpu: 10m
              memory: 128Mi
      serviceAccountName: retina-operator
      terminationGracePeriodSeconds: 10
      volumes:
        - name: "retina-operator-config"
          configMap:
            name: "retina-operator-config"
`;
