export interface Family {
  id: number;
  parentId: number | null;
  name: string;
  position: number;
  collapsed: boolean;
}

export interface Link {
  id: number;
  familyId: number;
  title: string;
  url: string;
  domain: string;
  note: string;
  tags: string[];
  favorite: boolean;
  position: number;
  clicks: number;
  lastClickAt: string | null;
  checkStatus: string | null;
  checkedAt: string | null;
  checkIgnored: boolean;
}

export interface Snapshot {
  families: Family[];
  links: Link[];
}
