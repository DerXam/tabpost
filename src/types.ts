export interface MailAccount {
  id: string;
  email: string;
  accountName?: string;
  password?: string; // Opted out of keeping physically on server unless requested
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface FolderNode {
  path: string;
  name: string;
  unreadCount: number;
  totalCount: number;
  specialUse?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';
}

export interface MailAddress {
  name?: string;
  address: string;
}

export interface MailMessage {
  uid: number;
  seq: number;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  date: string;
  flags: string[];
  size: number;
  /** Real attachment count from the IMAP body structure. Undefined for
   *  messages cached before this field existed. */
  attachmentCount?: number;
  snippet?: string;
  accountEmail?: string;
  folder?: string;
}

export interface MailMessageDetail {
  uid: number;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  date: string;
  flags: string[];
  html?: string;
  text?: string;
  attachments: {
    filename: string;
    contentType: string;
    size: number;
    index: number;
    contentId?: string;
  }[];
}
