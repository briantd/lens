import { workspaceStore } from "./workspace-store";
import path from "path";
import { app, ipcRenderer, remote, webFrame } from "electron";
import { unlink } from "fs-extra";
import { action, computed, observable, reaction, toJS } from "mobx";
import { BaseStore } from "./base-store";
import { Cluster, ClusterState } from "../main/cluster";
import migrations from "../migrations/cluster-store";
import logger from "../main/logger";
import { appEventBus } from "./event-bus";
import { dumpConfigYaml, LoadKubeError } from "./kube-helpers";
import { saveToAppFiles } from "./utils/saveToAppFiles";
import { KubeConfig } from "@kubernetes/client-node";
import { subscribeToBroadcast, unsubscribeAllFromBroadcast } from "./ipc";
import _ from "lodash";
import move from "array-move";
import type { WorkspaceId } from "./workspace-store";
import { notificationsStore, NotificationStatus } from "./notifications.store";

export interface ClusterIconUpload {
  clusterId: string;
  name: string;
  path: string;
}

export interface ClusterMetadata {
  [key: string]: string | number | boolean;
}

export interface ClusterStoreModel {
  activeCluster?: ClusterId; // last opened cluster
  clusters?: ClusterModel[]
}

export type ClusterId = string;

export interface ClusterModel {
  id: ClusterId;
  kubeConfigPath: string;
  workspace?: WorkspaceId;
  contextName?: string;
  preferences?: ClusterPreferences;
  metadata?: ClusterMetadata;
  ownerRef?: string;
  accessibleNamespaces?: string[];

  /** @deprecated */
  kubeConfig?: string; // yaml
}

export interface ClusterPreferences {
  terminalCWD?: string;
  clusterName?: string;
  prometheus?: {
    namespace: string;
    service: string;
    port: number;
    prefix: string;
  };
  prometheusProvider?: {
    type: string;
  };
  iconOrder?: number;
  icon?: string;
  httpsProxy?: string;
}

export interface ClusterRenderInfo extends ClusterModel {
  DeadError?: LoadKubeError; // this != undefined => dead
  isAdmin: boolean;
  name: string;
  eventCount: number;
  online: boolean;
}

export class ClusterStore extends BaseStore<ClusterStoreModel> {
  static getCustomKubeConfigPath(clusterId: ClusterId): string {
    return path.resolve((app || remote.app).getPath("userData"), "kubeconfigs", clusterId);
  }

  static embedCustomKubeConfig(clusterId: ClusterId, kubeConfig: KubeConfig | string): string {
    const filePath = ClusterStore.getCustomKubeConfigPath(clusterId);
    const fileContents = typeof kubeConfig == "string" ? kubeConfig : dumpConfigYaml(kubeConfig);
    saveToAppFiles(filePath, fileContents, { mode: 0o600 });
    return filePath;
  }

  @observable activeCluster: ClusterId;
  @observable removedClusters = observable.map<ClusterId, Cluster>();
  @observable clusters = observable.map<ClusterId, Cluster>();
  @observable deadClusters = observable.map<ClusterId, [ClusterModel, LoadKubeError]>();

  private constructor() {
    super({
      configName: "lens-cluster-store",
      accessPropertiesByDotNotation: false, // To make dots safe in cluster context names
      migrations: migrations,
    });

    this.pushStateToViewsAutomatically();
  }

  protected pushStateToViewsAutomatically() {
    if (!ipcRenderer) {
      reaction(() => this.connectedClustersList, () => {
        this.pushState();
      });
    }
  }

  registerIpcListener() {
    logger.info(`[CLUSTER-STORE] start to listen (${webFrame.routingId})`);
    subscribeToBroadcast("cluster:state", (event, clusterId: string, state: ClusterState) => {
      logger.silly(`[CLUSTER-STORE]: received push-state at ${location.host} (${webFrame.routingId})`, clusterId, state);
      this.getById(clusterId)?.setState(state);
    });
  }

  unregisterIpcListener() {
    super.unregisterIpcListener();
    unsubscribeAllFromBroadcast("cluster:state");
  }

  pushState() {
    this.clusters.forEach((c) => {
      c.pushState();
    });
  }

  get activeClusterId() {
    return this.activeCluster;
  }

  @computed get clustersList(): Cluster[] {
    return Array.from(this.clusters.values());
  }

  @computed get deadClustersList(): [ClusterModel, LoadKubeError][] {
    return Array.from(this.deadClusters.values());
  }

  @computed get enabledClustersList(): Cluster[] {
    return this.clustersList.filter((c) => c.enabled);
  }

  @computed get active(): Cluster | null {
    return this.getById(this.activeCluster);
  }

  @computed get connectedClustersList(): Cluster[] {
    return this.clustersList.filter((c) => !c.disconnected);
  }

  isActive(id: ClusterId) {
    return this.activeCluster === id;
  }

  @action
  setActive(id: ClusterId) {
    const clusterId = this.clusters.has(id) ? id : null;
    this.activeCluster = clusterId;
    workspaceStore.setLastActiveClusterId(clusterId);
  }

  @action
  swapIconOrders(workspace: WorkspaceId, from: number, to: number) {
    const clusters = this.getByWorkspaceId(workspace);
    if (from < 0 || to < 0 || from >= clusters.length || to >= clusters.length || isNaN(from) || isNaN(to)) {
      throw new Error(`invalid from<->to arguments`);
    }

    move.mutate(clusters, from, to);
    for (const i in clusters) {
      // This resets the iconOrder to the current display order
      clusters[i].preferences.iconOrder = +i;
    }
  }

  hasClusters() {
    return this.clusters.size > 0;
  }

  getById(id: ClusterId): Cluster {
    return this.clusters.get(id);
  }

  getDeadById(id: ClusterId): [ClusterModel, LoadKubeError] {
    return this.deadClusters.get(id);
  }

  getByWorkspaceId(workspaceId: string): ClusterRenderInfo[] {
    const aliveClusters: ClusterRenderInfo[] = this.clustersList.filter(c => c.workspace === workspaceId);
    const deadClusters: ClusterRenderInfo[] = this.deadClustersList
      .filter(([c]) => c.workspace === workspaceId)
      .map(([cluster, error]) => ({
        DeadError: error,
        name: cluster.contextName,
        isAdmin: false,
        eventCount: 0,
        online: false,
        ...cluster,
      }));


    return _.sortBy([...aliveClusters, ...deadClusters], c => c.preferences?.iconOrder);
  }

  getCountInWorkspace(workspaceId: string): number {
    const aliveCount = this.clustersList.filter(c => c.workspace === workspaceId).length;
    const deadCount = this.deadClustersList.filter(([c]) => c.workspace === workspaceId).length;

    return aliveCount + deadCount;
  }

  @action
  addClusters(...models: ClusterModel[]): Cluster[] {
    const clusters: Cluster[] = [];
    models.forEach(model => {
      clusters.push(this.addCluster(model));
    });

    return clusters;
  }

  @action
  addCluster(model: ClusterModel | Cluster): Cluster {
    appEventBus.emit({ name: "cluster", action: "add" });
    let cluster = model as Cluster;
    if (!(model instanceof Cluster)) {
      cluster = new Cluster(model);
    }
    this.clusters.set(model.id, cluster);
    return cluster;
  }

  async removeCluster(model: ClusterModel) {
    await this.removeById(model.id);
  }

  @action
  async removeById(clusterId: ClusterId) {
    appEventBus.emit({ name: "cluster", action: "remove" });
    const cluster = this.getById(clusterId);
    if (cluster) {
      this.clusters.delete(clusterId);
      if (this.activeCluster === clusterId) {
        this.setActive(null);
      }
      // remove only custom kubeconfigs (pasted as text)
      if (cluster.kubeConfigPath == ClusterStore.getCustomKubeConfigPath(clusterId)) {
        unlink(cluster.kubeConfigPath).catch(() => null);
      }
    }
  }

  @action
  removeByWorkspaceId(workspaceId: string) {
    this.getByWorkspaceId(workspaceId).forEach(cluster => {
      this.removeById(cluster.id);
    });
  }

  @action
  protected fromStore({ activeCluster, clusters = [] }: ClusterStoreModel = {}) {
    const currentClusters = this.clusters.toJS();
    const newClusters = new Map<ClusterId, Cluster>();
    const removedClusters = new Map<ClusterId, Cluster>();
    const deadClusters = new Map<ClusterId, [ClusterModel, LoadKubeError]>();

    // update new clusters
    for (const clusterModel of clusters) {
      let cluster = currentClusters.get(clusterModel.id);
      if (cluster) {
        cluster.updateModel(clusterModel);
      } else {
        try {
          cluster = new Cluster(clusterModel);
        } catch (err) {
          if (err instanceof LoadKubeError) {
            deadClusters.set(clusterModel.id, [clusterModel, err]);
            logger.error(`[CLUSTER-STORE]: marking cluster as dead`, {
              err,
              name: clusterModel.contextName,
              id: clusterModel.id,
            });

            notificationsStore.add({
              message: `Cluster ${clusterModel.contextName} is reporting an error: ${err.toString()}`,
              id: `${clusterModel.id}_IS_DEAD_NOTIFICATION`, // this **should** prevent double errors because we are loading the stores twice
              status: NotificationStatus.ERROR,
              timeout: 10000,
            });
            continue;
          }

          throw err;
        }

        if (!cluster.isManaged) {
          cluster.enabled = true;
        }
      }
      newClusters.set(clusterModel.id, cluster);
    }

    // update removed clusters
    currentClusters.forEach(cluster => {
      if (!newClusters.has(cluster.id)) {
        removedClusters.set(cluster.id, cluster);
      }
    });

    this.activeCluster = newClusters.has(activeCluster) ? activeCluster : null;
    this.deadClusters.replace(deadClusters);
    this.clusters.replace(newClusters);
    this.removedClusters.replace(removedClusters);
  }

  @computed private get clustersAsJson(): ClusterModel[] {
    const clusters = this.clustersList.map(c => c.toJSON());
    const dead = Array.from(this.deadClusters.values()).map(([c]) => c);

    return [...clusters, ...dead];
  }

  toJSON(): ClusterStoreModel {
    return toJS({
      activeCluster: this.activeCluster,
      clusters: this.clustersAsJson,
    }, {
      recurseEverything: true
    });
  }
}

export const clusterStore = ClusterStore.getInstance<ClusterStore>();

export function getClusterIdFromHost(hostname: string): ClusterId {
  const subDomains = hostname.split(":")[0].split(".");
  return subDomains.slice(-2)[0]; // e.g host == "%clusterId.localhost:45345"
}

export function getClusterFrameUrl(clusterId: ClusterId) {
  return `//${clusterId}.${location.host}`;
}

export function getHostedClusterId() {
  return getClusterIdFromHost(location.hostname);
}

export function getHostedCluster(): Cluster {
  return clusterStore.getById(getHostedClusterId());
}
